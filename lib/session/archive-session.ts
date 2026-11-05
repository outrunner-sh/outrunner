/**
 * Archiving a cloud session: a Workspace Snapshot of it, the session marked
 * `archived`, its box freed. The lifecycle route's Archive
 * (app/api/workspaces/[id]/lifecycle/route.ts), and an automation's next run
 * archiving the review session it replaces (lib/automations/runs.ts).
 *
 * The worktree is intentionally kept (Restore reclaims it later), so an
 * archived session is revivable, not destroyed.
 */

import { randomUUID } from "node:crypto";
import { after } from "next/server";

import type { Owner } from "@/lib/auth/owner";
import { releaseWorkspaceBox } from "@/lib/billing/release-box.deps";
import { listChatsOf } from "@/lib/db/chats";
import {
  createWorkspaceSnapshot,
  getWorkspaceComputer,
  readRuntimeComputerSecret,
  transitionWorkspace,
} from "@/lib/db/repositories";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_CHAT_SNAPSHOTS, AGENT_FEATURE_MULTI_REPO_SNAPSHOTS } from "@/lib/runtime/agent-protocol";
import { withRuntimeAgentRecovery } from "@/lib/runtime/agent-recovery";
import { requireFeature } from "@/lib/runtime/box-features";
import type { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { boxUpgrade } from "@/lib/runtime/session-environment";
import { mintSnapshotUpload } from "@/lib/runtime/storage";
import { supabaseSnapshotStorage } from "@/lib/runtime/storage/supabase-adapter";
import type { Workspace, WorkspaceStatus } from "@/lib/runtime/types";
import { ARCHIVED_UNSAVED, type ArchiveSave, saveForArchive } from "@/lib/session/archive-save";
import { archiveFailureReport, ArchivePreparationError, type ArchiveStage } from "@/lib/session/archive-failure";
import { archiveFailureLog } from "@/lib/session/archive-failure-log";
import { bringBack } from "@/lib/session/bring-back-box";
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

/** How an archive went: done (`unsaved`: without the session's work, its box
 *  out of reach, which `note` says), or why not (`conflict`: it's mid
 *  another lifecycle step; `reconcile`: archived, but its final state wasn't
 *  kept). */
export type ArchiveResult =
  | { ok: true; unsaved?: false }
  | { ok: true; unsaved: true; note: string }
  | { ok: false; reason: "conflict" | "reconcile" }
  | { ok: false; reason: "failed"; status: number; error: string; diagnostic?: ReturnType<typeof archiveFailureReport>["diagnostic"] };

/** The statuses a session is archived from: running, or asleep (the agent
 *  stops a session before capturing it, so nothing need relaunch it). */
const ARCHIVABLE: WorkspaceStatus[] = ["ready", "idle", "suspended", "failed"];

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
    return { ok: false, reason: "failed", status: 409, error: "Only an active, paused or failed session can be archived." };
  }
  const transitioned = await transitionWorkspace({
    id: workspace.id,
    ownerId: workspace.ownerId,
    from: [workspace.status],
    patch: { status: "archiving", errorMessage: null },
  });
  if (!transitioned) return { ok: false, reason: "conflict" };

  // The box the session was on, to tell one bringBack had to start in its
  // place (empty: the old one was deleted).
  let boxBefore: string | null = null;
  let save: ArchiveSave;
  let stage: ArchiveStage = "prepare";
  try {
    // A failed read must fail the archive: an unknown original id must
    // never make cleanup mistake the original disk for an empty replacement.
    boxBefore = (await getWorkspaceComputer(workspace))?.daytonaSandboxId ?? null;
    const archivedAt = new Date().toISOString();
    // Its other chats are captured beside the main conversation. Reading
    // their records must succeed before any archive can complete.
    const chats = await listChatsOf(workspace.id);
    let upload: Awaited<ReturnType<typeof mintSnapshotUpload>> | undefined;
    let chatUploads: ReturnType<typeof archiveChat>[] = [];

    stage = "capture";
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
              // An unreachable computer needs no storage upload URLs. First
              // prove the agent answers; recovery can then safely distinguish
              // a dead box from a real Snapshot preparation/save failure.
              await current.health(identity);
              // Require support for every repository and chat before saving
              // anything. Two archive clicks cannot both upgrade the box.
              const features = { features: async () => (await current.health(identity)).features ?? [], upgrade };
              if (workspace.checkouts) {
                await requireFeature(features, AGENT_FEATURE_MULTI_REPO_SNAPSHOTS, "archive a session of several repositories");
              }
              if (chats.length > 0) {
                await requireFeature(features, AGENT_FEATURE_CHAT_SNAPSHOTS, "archive a session with several chats");
              }
              if (!upload) {
                stage = "prepare";
                try {
                  const storage = supabaseSnapshotStorage();
                  const prepared = await mintSnapshotUpload(
                    storage, owner.id, workspace.id, archivedAt,
                    workspace.agent === "codex" ? ["rollout"] : [],
                  );
                  chatUploads = await Promise.all(
                    chats.map(async (chat) => {
                      const paths = chatUploadPaths(prepared.prefix, chat);
                      const conversation = (await storage.createSignedUploadUrl(paths.conversation)).signedUrl;
                      const rollout = paths.rollout ? (await storage.createSignedUploadUrl(paths.rollout)).signedUrl : undefined;
                      return archiveChat(chat, { conversation, ...(rollout && { rollout }) });
                    }),
                  );
                  upload = prepared;
                } catch (error) {
                  // A chat's storage URL failure is a save preparation failure,
                  // just like the main conversation's, never a dead computer.
                  throw new ArchivePreparationError(error);
                }
              }
              stage = "capture";
              const uploads = upload.urls.map((u) => ({ artifact: u.artifact, url: u.signedUrl }));
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
      if (!upload) throw new Error("Snapshot capture completed without prepared uploads");
      stage = "record";
      await createWorkspaceSnapshot({
        ownerId: owner.id,
        workspaceId: workspace.id,
        archivedAt,
        storagePath: upload.prefix,
        manifest: save.manifest,
      });
    } else {
      console.warn(`Workspace ${workspace.id}: its box couldn't be reached, so it's archived without its files`, save.cause);
    }
  } catch (error) {
    // A box that can't archive it, or a plan that won't start its box, says
    // so; the session stays as it was.
    const said = archiveFailureReport(error, stage, randomUUID());
    // Server-only legacy operation hints use fixed labels and numbers; the
    // public/persisted report remains separate. Never log a raw agent error.
    console.error("archive_failed", { workspaceId: workspace.id, ...archiveFailureLog(error, said.diagnostic) });
    await transitionWorkspace({
      id: workspace.id,
      ownerId: workspace.ownerId,
      from: ["archiving"],
      patch: { status: workspace.status, errorMessage: said.error },
    }).catch((updateError: unknown) => console.error("Could not persist archive failure", updateError));
    return { ok: false, reason: "failed", ...said };
  }

  const completed = await transitionWorkspace({
    id: workspace.id,
    ownerId: workspace.ownerId,
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
