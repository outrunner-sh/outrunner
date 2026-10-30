/**
 * The real collaborators of an import's plan and commit: the database through
 * the user's own client (RLS confines every read and write to them), Snapshot
 * storage through the service role, GitHub through the user's token.
 */

import { mapWithConcurrency } from "@/lib/concurrency";
import { getSandboxSettings, ownSandboxKeys } from "@/lib/db/credentials";
import { createWorkspaceSnapshot, getProject, getWorkspace, listProjects, upsertProjects } from "@/lib/db/repositories";
import { connectRepositories, type ConnectDeps } from "@/lib/github/connect";
import { ImportError, type CommitDeps } from "@/lib/imports/commit";
import type { PlanDeps } from "@/lib/imports/plan";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { NoDaytonaKeyError } from "@/lib/runtime/daytona-provider";
import { providerForNewSessions } from "@/lib/runtime/sandbox-choice";
import { SNAPSHOT_BUCKET } from "@/lib/runtime/storage/snapshots";
import { NoModalTokenError } from "@/lib/runtime/user-modal-provider";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

/** Upload URLs minted at once. */
const MINT_CONCURRENCY = 6;

/** The branches a project's workspaces hold: every one not destroyed. */
async function branchesInUse(projectId: string): Promise<Set<string>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("branch")
    .eq("project_id", projectId)
    .neq("status", "destroyed");
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.branch));
}

/** The provider an imported session is restored on: the user's sandbox for
 *  new sessions, which must be a Runtime Computer (Restore runs on one). */
export async function importProvider(ownerId: string): Promise<string> {
  let provider;
  try {
    provider = providerForNewSessions(await getSandboxSettings(ownerId), ownSandboxKeys(ownerId));
  } catch (error) {
    if (error instanceof NoDaytonaKeyError || error instanceof NoModalTokenError) throw new ImportError(error.message, 409);
    throw error;
  }
  if (!isComputerProvider(provider)) {
    throw new ImportError(
      "Imported sessions require a cloud computer. Ask your deployment administrator to check runtime configuration.",
      409,
    );
  }
  return provider.name;
}

/** `orgId`: the org the user is looking at, where its projects go. */
export function planDeps(ownerId: string, lookup: ConnectDeps["lookup"], orgId?: string): PlanDeps {
  const bucket = createSupabaseAdminClient().storage.from(SNAPSHOT_BUCKET);
  return {
    async connect(fullNames) {
      const { repositories } = await connectRepositories(ownerId, fullNames, {
        lookup,
        upsert: (owner, repos) => upsertProjects(owner, repos, orgId),
      });
      const byRepoId = new Map((await listProjects(orgId)).map((p) => [p.githubRepoId, p.id]));
      return repositories.flatMap((repository) => {
        const projectId = byRepoId.get(repository.githubRepoId);
        return projectId ? [{ repository, projectId }] : [];
      });
    },
    branchesInUse,
    async importedBefore(keys) {
      const supabase = await createSupabaseServerClient();
      const { data, error } = await supabase
        .from("workspace_imports")
        .select("session_key, imported_at, workspace_id")
        .in("session_key", keys);
      if (error) throw error;
      const rows = data ?? [];
      if (rows.length === 0) return new Map();
      // Only a workspace still there counts: a destroyed one can come again.
      const { data: live, error: liveError } = await supabase
        .from("workspaces")
        .select("id")
        .in("id", rows.map((r) => r.workspace_id))
        .neq("status", "destroyed");
      if (liveError) throw liveError;
      const liveIds = new Set((live ?? []).map((w) => w.id));
      const before = new Map<string, string>();
      for (const row of rows) {
        if (liveIds.has(row.workspace_id) && (before.get(row.session_key) ?? "") < row.imported_at) {
          before.set(row.session_key, row.imported_at);
        }
      }
      return before;
    },
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
    async mintUploads(paths) {
      const minted = await mapWithConcurrency(paths, MINT_CONCURRENCY, async (path) => {
        const { data, error } = await bucket.createSignedUploadUrl(path);
        if (error || !data) throw new Error(`failed to mint upload URL for "${path}": ${error?.message ?? "no data"}`);
        return [path, data.signedUrl] as const;
      });
      return new Map(minted);
    },
  };
}

export function commitDeps(ownerId: string): CommitDeps {
  const bucket = createSupabaseAdminClient().storage.from(SNAPSHOT_BUCKET);
  return {
    async getProject(id) {
      // RLS: another user's project reads as none.
      const project = await getProject(id);
      return project ? { id: project.id, defaultBranch: project.defaultBranch } : null;
    },
    branchesInUse,
    async workspaceExists(id) {
      return (await getWorkspace(id)) !== null;
    },
    async storedSizes(prefix) {
      const { data, error } = await bucket.list(prefix.replace(/\/$/, ""), { limit: 100 });
      if (error) throw error;
      return new Map(
        (data ?? []).flatMap((object) => {
          const size = (object.metadata as { size?: unknown } | null)?.size;
          return typeof size === "number" ? [[object.name, size] as const] : [];
        }),
      );
    },
    async putObject(path, body, contentType) {
      const { error } = await bucket.upload(path, body, { contentType, upsert: false });
      if (error) throw error;
    },
    provider: () => importProvider(ownerId),
    async insertWorkspace(row) {
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.from("workspaces").insert({
        id: row.id,
        owner_id: ownerId,
        project_id: row.projectId,
        branch: row.branch,
        base_branch: row.baseBranch,
        provider: row.provider,
        // Named only for Codex, as createWorkspaceRow does.
        ...(row.agent !== "claude" && { agent: row.agent }),
        title: row.title,
        status: "archived",
      });
      if (error) throw error;
    },
    async insertSnapshot(row) {
      await createWorkspaceSnapshot({ ownerId, ...row });
    },
    async insertImport(row) {
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.from("workspace_imports").insert({
        owner_id: ownerId,
        workspace_id: row.workspaceId,
        session_key: row.key,
        source: row.source,
        conversation_sha256: row.conversationSha256,
        imported_at: row.importedAt,
      });
      if (error) throw error;
    },
    async deleteWorkspace(id) {
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.from("workspaces").delete().eq("id", id);
      if (error) throw error;
    },
    now: () => new Date(),
  };
}
