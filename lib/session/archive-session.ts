/**
 * Archiving a cloud session: a Workspace Snapshot of it, the session marked
 * `archived`, its box freed. The lifecycle route's Archive
 * (app/api/workspaces/[id]/lifecycle/route.ts), and an automation's next run
 * archiving the review session it replaces (lib/automations/runs.ts).
 *
 * The worktree is intentionally kept (Restore reclaims it later), so an
 * archived session is revivable, not destroyed.
 */

import { after } from "next/server";

import type { Owner } from "@/lib/auth/owner";
import { releaseWorkspaceBox } from "@/lib/billing/release-box.deps";
import {
  createWorkspaceSnapshot,
  getWorkspaceComputer,
  readRuntimeComputerSecret,
  transitionWorkspace,
} from "@/lib/db/repositories";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_MULTI_REPO_SNAPSHOTS } from "@/lib/runtime/agent-protocol";
import { requireFeature } from "@/lib/runtime/box-features";
import type { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";
import { boxUpgrade } from "@/lib/runtime/session-environment";
import { mintSnapshotUpload } from "@/lib/runtime/storage";
import { supabaseSnapshotStorage } from "@/lib/runtime/storage/supabase-adapter";
import type { Workspace } from "@/lib/runtime/types";

/** The agent on a session's box, to ask it things as its owner. */
export async function daytonaAgent(
  workspace: Workspace,
  provider: ComputerRuntimeProvider,
  owner: Owner,
): Promise<{
  agent: AgentClient;
  identity: WorkspaceIdentity;
  upgrade?: () => Promise<void>;
  sandboxId: string;
  secret: string;
}> {
  const computer = await getWorkspaceComputer(workspace);
  if (!computer?.daytonaSandboxId || computer.status !== "ready") {
    throw new Error("Runtime Computer is not available.");
  }
  const secret = await readRuntimeComputerSecret(computer.id);
  if (!secret) throw new Error("Runtime Computer secret is missing.");
  const target = await provider.agentTarget(computer.daytonaSandboxId, secret);
  return {
    upgrade: boxUpgrade(provider, computer.daytonaSandboxId, secret, owner.id, workspace.id),
    agent: new AgentClient(target),
    sandboxId: computer.daytonaSandboxId,
    secret,
    identity: {
      workspaceId: workspace.id,
      projectId: workspace.projectId,
      computerId: computer.id,
      userId: owner.id,
    },
  };
}

function archiveError(): string {
  return "Could not archive this workspace. Check Outrunner's setup and try again.";
}

/** How an archive went: done, or why not (`conflict`: it's mid another
 *  lifecycle step; `reconcile`: archived, but its final state wasn't kept). */
export type ArchiveResult =
  | { ok: true }
  | { ok: false; reason: "conflict" | "reconcile" }
  | { ok: false; reason: "failed"; status: number; error: string };

/**
 * Archive a ready or idle cloud session: Next mints one signed upload URL per
 * artifact, the agent captures and uploads them (manifest last) and returns
 * the manifest, which is cached on a `workspace_snapshots` row; the session is
 * then `archived`, and its box freed once it's the last off it. A failure
 * leaves the session as it was, saying why.
 */
export async function archiveCloudSession(
  workspace: Workspace,
  provider: ComputerRuntimeProvider,
  owner: Owner,
): Promise<ArchiveResult> {
  if (workspace.status !== "ready" && workspace.status !== "idle") {
    return { ok: false, reason: "failed", status: 409, error: "Only an active workspace can be archived." };
  }
  const transitioned = await transitionWorkspace({
    id: workspace.id,
    from: ["ready", "idle"],
    patch: { status: "archiving", errorMessage: null },
  });
  if (!transitioned) return { ok: false, reason: "conflict" };

  try {
    const archivedAt = new Date().toISOString();
    const { prefix, urls } = await mintSnapshotUpload(
      supabaseSnapshotStorage(),
      owner.id,
      workspace.id,
      archivedAt,
      // A Codex session's raw rollout too, so a restore resumes Codex itself
      // (only an agent that runs Codex is asked: an older one refuses it).
      workspace.agent === "codex" ? ["rollout"] : [],
    );
    const uploads = urls.map((u) => ({ artifact: u.artifact, url: u.signedUrl }));

    const { agent, identity, upgrade } = await daytonaAgent(workspace, provider, owner);
    // A session of several repositories is archived by an agent that can (its
    // box upgraded in place first where it can be): after the transition, so
    // two clicks don't both upgrade it.
    if (workspace.checkouts) {
      const features = { features: async () => (await agent.health(identity)).features ?? [], upgrade };
      await requireFeature(features, AGENT_FEATURE_MULTI_REPO_SNAPSHOTS, "archive a session of several repositories");
    }
    const manifest = await agent.archiveWorkspace(identity, { archivedAt, uploads });

    await createWorkspaceSnapshot({
      ownerId: owner.id,
      workspaceId: workspace.id,
      archivedAt,
      storagePath: prefix,
      manifest,
    });
  } catch (error) {
    console.error(`Workspace ${workspace.id} archive failed`, error);
    // A box that can't archive it says so; the session runs on.
    const message = error instanceof OutdatedComputerError ? error.message : archiveError();
    await transitionWorkspace({
      id: workspace.id,
      from: ["archiving"],
      patch: { status: workspace.status, errorMessage: message },
    }).catch((updateError: unknown) => console.error("Could not persist archive failure", updateError));
    return { ok: false, reason: "failed", status: error instanceof OutdatedComputerError ? 409 : 502, error: message };
  }

  const completed = await transitionWorkspace({
    id: workspace.id,
    from: ["archiving"],
    patch: { status: "archived", errorMessage: null },
  });
  if (!completed) return { ok: false, reason: "reconcile" };
  // The last session off its box frees it: paused now, not when idle.
  after(() => releaseWorkspaceBox(provider, workspace, false));
  return { ok: true };
}
