import { projectBranchesLike } from "@/lib/db/repositories";
import { branchKnownOnGitHub } from "@/lib/github/client";
import { optionalGitToken } from "@/lib/github/identity.deps";
import type { RenameBranchDeps } from "@/lib/session/rename-branch";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * What a rename reads and writes (lib/session/rename-branch.ts), for the
 * session tools: past row-level security, as their route is, for the one
 * session the box was checked to hold, with the GitHub tokens of its user.
 */
export function renameBranchDeps(): RenameBranchDeps {
  const db = createSupabaseAdminClient();

  /** The session's repositories, with its user's token for each: read once
   *  a session for this request, however many names it checks. */
  const reposOf = new Map<string, Promise<{ fullName: string; token: string | undefined }[]>>();
  function repos(id: string): Promise<{ fullName: string; token: string | undefined }[]> {
    let found = reposOf.get(id);
    if (!found) {
      found = readRepos(id);
      reposOf.set(id, found);
    }
    return found;
  }

  async function readRepos(id: string): Promise<{ fullName: string; token: string | undefined }[]> {
    const { data: workspace, error } = await db.from("workspaces").select("owner_id, project_id, checkouts").eq("id", id).single();
    if (error) throw error;
    const { data: project, error: projectError } = await db.from("projects").select("full_name, org_id").eq("id", workspace.project_id).single();
    if (projectError) throw projectError;
    const names = new Set<string>([project.full_name]);
    for (const c of (Array.isArray(workspace.checkouts) ? workspace.checkouts : []) as { fullName?: unknown }[]) {
      if (typeof c?.fullName === "string") names.add(c.fullName);
    }
    return Promise.all(
      [...names].map(async (fullName) => ({
        fullName,
        token: await optionalGitToken(workspace.owner_id, { orgId: project.org_id, fullName }),
      })),
    );
  }

  return {
    async session(id) {
      const { data, error } = await db.from("workspaces").select("id, branch, branch_renamable").eq("id", id).maybeSingle();
      if (error) throw error;
      return data ? { id: data.id, branch: data.branch, branchRenamable: data.branch_renamable === true } : null;
    },
    async hasPullRequest(id) {
      const [own, runner] = await Promise.all([
        db.from("pull_requests").select("id").eq("workspace_id", id).limit(1),
        db.from("runner_pull_requests").select("runner_id").eq("runner_id", id).limit(1),
      ]);
      if (own.error) throw own.error;
      if (runner.error) throw runner.error;
      return (own.data?.length ?? 0) > 0 || (runner.data?.length ?? 0) > 0;
    },
    async sessionBranches(id, base) {
      const { data, error } = await db.from("workspaces").select("project_id").eq("id", id).single();
      if (error) throw error;
      return projectBranchesLike(data.project_id, base);
    },
    async knownOnGitHub(id, branch) {
      const known = await Promise.all(
        (await repos(id)).map((repo) =>
          repo.token ? branchKnownOnGitHub({ token: repo.token, repoFullName: repo.fullName, branch }) : false,
        ),
      );
      return known.some(Boolean);
    },
    async rename(id, from, to) {
      const { data, error } = await db
        .from("workspaces")
        .update({ branch: to, branch_renamable: false })
        .eq("id", id)
        .eq("branch", from)
        .eq("branch_renamable", true)
        .select("id");
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    },
    async settle(id) {
      const { error } = await db.from("workspaces").update({ branch_renamable: false }).eq("id", id);
      if (error) throw error;
    },
  };
}
