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
import { CloudLimitError, isPlanLimitError } from "@/lib/billing/limits";
import { releaseWorkspaceBox } from "@/lib/billing/release-box.deps";
import { listChatsOf } from "@/lib/db/chats";
import {
  createWorkspaceSnapshot,
  getWorkspaceComputer,
  readRuntimeComputerSecret,
  transitionWorkspace,
} from "@/lib/db/repositories";
import { AgentClient, AgentRequestError, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_CHAT_SNAPSHOTS, AGENT_FEATURE_MULTI_REPO_SNAPSHOTS } from "@/lib/runtime/agent-protocol";
import { withRuntimeAgentRecovery } from "@/lib/runtime/agent-recovery";
import { requireFeature } from "@/lib/runtime/box-features";
import type { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";
import { boxUpgrade } from "@/lib/runtime/session-environment";
import { mintSnapshotUpload } from "@/lib/runtime/storage";
import { supabaseSnapshotStorage } from "@/lib/runtime/storage/supabase-adapter";
import type { Workspace, WorkspaceStatus } from "@/lib/runtime/types";
import { ARCHIVED_UNSAVED, type ArchiveSave, saveForArchive } from "@/lib/session/archive-save";
import { bringBack } from "@/lib/session/bring-back-box";
import { bringBackFailure, MissingBoxProjectError } from "@/lib/session/box-failure";
import { archiveChat, chatUploadPaths } from "@/lib/session/chat-snapshots";

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
  return "Could not archive this session. Try again in a moment.";
}

/** How an archive went: done (`unsaved`: without the session's work, its box
 *  out of reach, which `note` says), or why not (`conflict`: it's mid
 *  another lifecycle step; `reconcile`: archived, but its final state wasn't
 *  kept). */
export type ArchiveResult =
  | { ok: true; unsaved?: false }
  | { ok: true; unsaved: true; note: string }
  | { ok: false; reason: "conflict" | "reconcile" }
  | { ok: false; reason: "failed"; status: number; error: string };

/** The statuses a session is archived from: running, or asleep (the agent
 *  stops a session before capturing it, so nothing need relaunch it). */
const ARCHIVABLE: WorkspaceStatus[] = ["ready", "idle", "suspended"];

/**
 * Archive a cloud session: its box brought back if it isn't up, Next mints
 * one signed upload URL per artifact, the agent captures and uploads them
 * (manifest last) and returns the manifest, which is cached on a
 * `workspace_snapshots` row; the session is then `archived`, and its box
 * freed once it's the last off it.
 *
 * A box that can't be brought back or reached (stopped, archived or deleted
 * on the provider, or not answering) doesn't stop it: the session is archived
 * without a Snapshot, its row saying its uncommitted files were lost
 * (lib/session/archive-save.ts). Any other failure leaves the session as it
 * was, saying why.
 */
export async function archiveCloudSession(
  workspace: Workspace,
  provider: ComputerRuntimeProvider,
  owner: Owner,
  options: { requireSnapshot?: boolean } = {},
): Promise<ArchiveResult> {
  if (!ARCHIVABLE.includes(workspace.status)) {
    return { ok: false, reason: "failed", status: 409, error: "Only an active or paused session can be archived." };
  }
  const transitioned = await transitionWorkspace({
    id: workspace.id,
    from: [workspace.status],
    patch: { status: "archiving", errorMessage: null },
  });
  if (!transitioned) return { ok: false, reason: "conflict" };

  // The box the session was on, to tell one bringBack had to start in its
  // place (empty: the old one was deleted).
  let boxBefore: string | null = null;
  let save: ArchiveSave;
  try {
    // A failed read must fail the archive: an unknown original id must
    // never make cleanup mistake the original disk for an empty replacement.
    boxBefore = (await getWorkspaceComputer(workspace))?.daytonaSandboxId ?? null;
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
    // Its other chats, each captured beside the main conversation: a
    // Snapshot that lost them would lose their history.
    const chats = await listChatsOf(workspace.id);

    save = await saveForArchive({
      bringBack: async () => {
        const computer = await getWorkspaceComputer(workspace);
        if (computer && provider.restoresBoxes) await bringBack(provider, workspace, computer, owner);
      },
      connect: () => daytonaAgent(workspace, provider, owner),
      // An agent that doesn't answer on a box that's up is redeployed and
      // asked again: its files are there to save.
      capture: async ({ agent, identity, upgrade, sandboxId, secret }) =>
        (
          await withRuntimeAgentRecovery(
            { provider, sandboxId, secret, agent, identity, upgrade, workspaceId: workspace.id },
            async (current) => {
              // A session of several repositories, or chats, is archived by
              // an agent that can (its box upgraded in place first where it
              // can): after the transition, so two clicks don't both upgrade it.
              const features = { features: async () => (await current.health(identity)).features ?? [], upgrade };
              if (workspace.checkouts) {
                await requireFeature(features, AGENT_FEATURE_MULTI_REPO_SNAPSHOTS, "archive a session of several repositories");
              }
              if (chats.length > 0) {
                await requireFeature(features, AGENT_FEATURE_CHAT_SNAPSHOTS, "archive a session with several chats");
              }
              const storage = supabaseSnapshotStorage();
              const chatUploads = await Promise.all(
                chats.map(async (chat) => {
                  const paths = chatUploadPaths(prefix, chat);
                  const conversation = (await storage.createSignedUploadUrl(paths.conversation)).signedUrl;
                  const rollout = paths.rollout ? (await storage.createSignedUploadUrl(paths.rollout)).signedUrl : undefined;
                  return archiveChat(chat, { conversation, ...(rollout && { rollout }) });
                }),
              );
              return current.archiveWorkspace(identity, {
                archivedAt,
                uploads,
                ...(chatUploads.length > 0 && { chats: chatUploads }),
              });
            },
          )
        ).result,
    }, options);
    if (save.saved) {
      await createWorkspaceSnapshot({
        ownerId: owner.id,
        workspaceId: workspace.id,
        archivedAt,
        storagePath: prefix,
        manifest: save.manifest,
      });
    } else {
      console.warn(`Workspace ${workspace.id}: its box couldn't be reached, so it's archived without its files`, save.cause);
    }
  } catch (error) {
    console.error(`Workspace ${workspace.id} archive failed`, error);
    // A box that can't archive it, or a plan that won't start its box, says
    // so; the session stays as it was.
    const said = archiveFailure(error);
    await transitionWorkspace({
      id: workspace.id,
      from: ["archiving"],
      patch: { status: workspace.status, errorMessage: said.error },
    }).catch((updateError: unknown) => console.error("Could not persist archive failure", updateError));
    return { ok: false, reason: "failed", ...said };
  }

  const completed = await transitionWorkspace({
    id: workspace.id,
    from: ["archiving"],
    patch: { status: "archived", errorMessage: save.saved ? null : ARCHIVED_UNSAVED },
  });
  if (!completed) return { ok: false, reason: "reconcile" };
  if (save.saved) {
    // The last session off its box frees it: paused now, not when idle.
    after(() => releaseWorkspaceBox(provider, workspace, false));
    return { ok: true };
  }
  // Out of reach: its own box is paused, its disk kept, unless bringBack had
  // to start an empty one in its place, which goes.
  after(async () => {
    const boxNow = (await getWorkspaceComputer(workspace).catch(() => null))?.daytonaSandboxId ?? null;
    await releaseWorkspaceBox(provider, workspace, boxBefore !== null && boxNow !== null && boxNow !== boxBefore);
  });
  return { ok: true, unsaved: true, note: ARCHIVED_UNSAVED };
}

/** What a failed archive answers: the plan's refusal, a box too old to
 *  archive it, or a failure of Outrunner's own (its storage, say), to try
 *  again. */
function archiveFailure(error: unknown): { status: number; error: string } {
  if (error instanceof MissingBoxProjectError) {
    const failure = bringBackFailure(error);
    return { status: failure.status, error: failure.body.error };
  }
  if (error instanceof CloudLimitError) return { status: 403, error: error.denial.error };
  const refused = isPlanLimitError(error);
  if (refused) return { status: 403, error: refused.message };
  if (error instanceof OutdatedComputerError) return { status: 409, error: error.message };
  if (error instanceof AgentRequestError && error.error?.message) return { status: 502, error: error.error.message };
  return { status: 502, error: archiveError() };
}
