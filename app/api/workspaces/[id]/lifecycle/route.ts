import { after, NextResponse } from "next/server";

import { resolveAgentAuth, type ResolvedAuth } from "@/lib/agents/resolve";
import { getOwner, type Owner } from "@/lib/auth/owner";
import { deleteCachedBoxImages } from "@/lib/db/chat-images";
import { projectOrgId } from "@/lib/db/work-items";
import { cloudBoxStartGate, isPlanLimitError, UPGRADE_HREF } from "@/lib/billing/limits";
import { releaseWorkspaceBox } from "@/lib/billing/release-box.deps";
import { listChatsOf } from "@/lib/db/chats";
import { agentAuthStore, modelKey, modelMenu } from "@/lib/db/credentials";
import { gitTokensFor, optionalGitToken, sessionGitAs } from "@/lib/github/identity.deps";
import {
  clearWorkspaceFirstPrompt,
  deleteWorkspaceSnapshots,
  getProject,
  getWorkspaceComputer,
  getWorkspace,
  listWorkspaceSnapshots,
  markRuntimeComputerStoppedIfReady,
  recordWorkspaceModel,
  transitionWorkspace,
  updateWorkspace,
} from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import {
  AGENT_FEATURE_CHAT_SNAPSHOTS,
  AGENT_FEATURE_CODEX_GATEWAY,
  AGENT_FEATURE_IMPORTS,
  AGENT_FEATURE_MULTI_REPO_SNAPSHOTS,
  AGENT_FEATURE_RESTORE_MODEL,
} from "@/lib/runtime/agent-protocol";
import { withRuntimeAgentRecovery } from "@/lib/runtime/agent-recovery";
import { requireFeature } from "@/lib/runtime/box-features";
import { setUpSession } from "@/lib/runtime/session-setup.deps";
import { isComputerProvider, type ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { scopeOf } from "@/lib/runtime/computer-scope";
import { recordedModelRequest } from "@/lib/runtime/model-switch";
import { readyChatRelaunch, readyRelaunch } from "@/lib/runtime/relaunch.deps";
import {
  relaunchNeedsAccount,
  restoreSignedIn,
  sessionAuthClient,
  signInFailure,
} from "@/lib/runtime/session-auth";
import { defaultModel, onCodexGateway, type RecordedModel } from "@/lib/runtime/session-models";
import { boxUpgrade, runtimeSessionEnvironment } from "@/lib/runtime/session-environment";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import { ensureComputer } from "@/lib/runtime/runtime-computer-service";
import { endedBoxOf } from "@/lib/runtime/sandbox-choice";
import { mintSnapshotDownloadUrl } from "@/lib/runtime/storage";
import { ARCHIVED_UNSAVED } from "@/lib/session/archive-save";
import { supabaseSnapshotStorage } from "@/lib/runtime/storage/supabase-adapter";
import type { SnapshotManifest } from "@/lib/runtime/snapshot/manifest";
import type { RuntimeProvider, Workspace, WorkspaceStatus } from "@/lib/runtime/types";
import { archiveCloudSession, daytonaAgent } from "@/lib/session/archive-session";
import { bringBack } from "@/lib/session/bring-back-box";
import { restoreChats } from "@/lib/session/chat-snapshots";
import { canDestroy } from "@/lib/session/provisioning";
import { resumeFailure, type ResumeStage } from "@/lib/session/resume-failure";

// resume/restore ensure a Runtime Computer (provision + agent boot, ~15s+), and
// archive/restore move snapshot artifacts; keep the same 60s cap as provisioning
// (serverless hosts only; a no-op on a long-running server like Railway).
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };
type LifecycleAction = "resume" | "suspend" | "destroy" | "archive" | "restore";

function actionFor(body: unknown): LifecycleAction | null {
  if (!body || typeof body !== "object" || !("action" in body)) return null;
  const action = body.action;
  return action === "resume" ||
    action === "suspend" ||
    action === "destroy" ||
    action === "archive" ||
    action === "restore"
    ? action
    : null;
}

async function startTransition(
  workspace: Workspace,
  from: WorkspaceStatus[],
  status: WorkspaceStatus,
): Promise<Workspace | null> {
  return transitionWorkspace({
    id: workspace.id,
    ownerId: workspace.ownerId,
    from,
    // A failed setup is deleted by Try again. Keep its diagnostic on the
    // retained row through teardown, including if the request is cut off.
    patch: { status, ...(status !== "destroying" && { errorMessage: null }) },
  });
}

async function restoreAfterFailure(
  workspace: Workspace,
  transitionStatus: WorkspaceStatus,
  message: string,
): Promise<void> {
  await transitionWorkspace({
    id: workspace.id,
    ownerId: workspace.ownerId,
    from: [transitionStatus],
    patch: { status: workspace.status, errorMessage: message },
  });
}

async function completeTransition(input: {
  id: string;
  ownerId: string;
  from: WorkspaceStatus;
  patch: Parameters<typeof transitionWorkspace>[0]["patch"];
}): Promise<boolean> {
  return Boolean(
    await transitionWorkspace({
      id: input.id,
      ownerId: input.ownerId,
      from: [input.from],
      patch: input.patch,
    }),
  );
}

function lifecycleError(action: LifecycleAction): string {
  return `Could not ${action} this workspace. Check Outrunner's setup and try again.`;
}

/** Resume, suspend, or permanently destroy a persisted workspace. */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json(
      { error: "Sign in to Outrunner first." },
      { status: 401 },
    );
  }

  let action: LifecycleAction | null = null;
  let requireSnapshot = false;
  try {
    const body: unknown = await request.json();
    action = actionFor(body);
    requireSnapshot = typeof body === "object" && body !== null && "requireSnapshot" in body && body.requireSnapshot === true;
  } catch {
    // Handled below as a deliberately generic bad request.
  }
  if (!action) {
    return NextResponse.json(
      { error: "Use resume, suspend, destroy, archive, or restore." },
      { status: 400 },
    );
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) {
    // A session on a provider this deployment doesn't run (it was switched,
    // or another build of Outrunner made it) can't be reached to tear down,
    // but it can still be deleted: Outrunner forgets it, as a destroy does
    // when the session's box is gone.
    if (action === "destroy" && resolution.status === 409) return endWorkspace(workspace);
    return providerErrorResponse(resolution);
  }
  const provider = resolution.provider;

  if (isComputerProvider(provider)) {
    return daytonaLifecycle(action, workspace, provider, owner, { requireSnapshot });
  }

  // Archive/restore operate on the runtime-agent's Session + Snapshot; only the
  // Daytona-backed Runtime provides them. Legacy providers can't.
  if (action === "archive" || action === "restore") {
    return NextResponse.json(
      { error: "Archive and restore are only supported on Runtime Computer workspaces." },
      { status: 409 },
    );
  }
  if (action === "resume") return resumeWorkspace(workspace, provider);
  if (action === "suspend") return suspendWorkspace(workspace, provider);
  return destroyWorkspace(workspace, provider);
}

async function daytonaLifecycle(
  action: LifecycleAction,
  workspace: Workspace,
  provider: ComputerRuntimeProvider,
  owner: Owner,
  archiveOptions: { requireSnapshot?: boolean } = {},
) {
  if (action === "resume") return resumeDaytonaWorkspace(workspace, provider, owner);
  if (action === "suspend") return suspendDaytonaWorkspace(workspace, provider, owner);
  if (action === "archive") return archiveDaytonaWorkspace(workspace, provider, owner, archiveOptions);
  if (action === "restore") return restoreDaytonaWorkspace(workspace, provider, owner);
  return destroyDaytonaWorkspace(workspace, provider, owner);
}

/** Archive → a Workspace Snapshot (lib/session/archive-session.ts). */
async function archiveDaytonaWorkspace(
  workspace: Workspace,
  provider: ComputerRuntimeProvider,
  owner: Owner,
  options: { requireSnapshot?: boolean } = {},
) {
  const archived = await archiveCloudSession(workspace, provider, owner, options);
  if (archived.ok) {
    // `note`: archived without its files, which the user is told.
    return NextResponse.json({ workspace: { id: workspace.id, status: "archived" }, ...(archived.unsaved && { note: archived.note }) });
  }
  if (archived.reason === "failed") return NextResponse.json({ error: archived.error, ...(archived.diagnostic && { diagnostic: archived.diagnostic }) }, { status: archived.status });
  return archived.reason === "reconcile" ? lifecycleReconciliationRequired("archive") : lifecycleConflict();
}

/**
 * Restore → revive an archived Session from its Snapshot. Ensures a Runtime
 * Computer for the project (provisioning one if none — NOT necessarily the
 * original box), mints signed download URLs for the tree + conversation, and
 * has the agent rebuild + VERIFY the worktree before relaunching Claude with
 * `--continue`. A verification failure surfaces as an error and leaves the
 * workspace archived rather than half-restored.
 */
async function restoreDaytonaWorkspace(
  workspace: Workspace,
  provider: ComputerRuntimeProvider,
  owner: Owner,
) {
  if (workspace.status !== "archived") {
    return NextResponse.json(
      { error: "Only an archived workspace can be restored." },
      { status: 409 },
    );
  }
  const snapshot = (await listWorkspaceSnapshots(workspace.id))[0];
  if (!snapshot) {
    // Archived while its box was out of reach (lib/session/archive-save.ts):
    // nothing of its work was kept to restore.
    return NextResponse.json(
      {
        error: workspace.errorMessage === ARCHIVED_UNSAVED
          ? "This session was archived without its files (its box couldn't be reached), so it can't be reopened. Anything pushed to GitHub is kept: continue in a new session."
          : "This workspace has no Snapshot to restore.",
      },
      { status: 409 },
    );
  }
  // The Snapshot's trees are the session's repositories, folder for folder:
  // otherwise the agent would read a tar as a bundle, or miss a checkout.
  // Checked before any box starts: such a restore can never succeed.
  if (!snapshotMatchesSession(snapshot.manifest.tree, workspace.checkouts)) {
    return NextResponse.json(
      { error: "This session's Snapshot doesn't hold the repositories the session has, so it can't be restored." },
      { status: 409 },
    );
  }
  // The box it restores on: its own (paused when it was archived), or, for a
  // session from before each had its own, its project's shared one.
  const currentComputer = await getWorkspaceComputer(workspace);
  const scope = scopeOf(workspace, currentComputer);
  // A box may be about to start (the box may be gone): the plan's hours and
  // box count get their say before anything changes.
  // The org's plan (billing is the org's).
  const orgId = workspace.orgId ?? (await projectOrgId(workspace.projectId));
  if (!orgId) return NextResponse.json({ error: "This session's project is gone." }, { status: 404 });
  const gate = await cloudBoxStartGate(owner, orgId, provider.name, scope);
  if ("denial" in gate) return NextResponse.json(gate.denial, { status: 403 });
  const transitioned = await startTransition(workspace, ["archived"], "restoring");
  if (!transitioned) return lifecycleConflict();

  try {
    const project = await getProject(workspace.projectId);
    if (!project) throw new Error("Project not found for restore.");
    // A review box's mirror as the App, as on create: never its user's token.
    const as = await sessionGitAs(workspace.id);
    const githubToken = await optionalGitToken(owner.id, project, as);

    // Manifest pointers -> signed download URLs for exactly what the agent needs.
    const storage = supabaseSnapshotStorage();
    const { manifest, storagePath } = snapshot;
    const downloads = await Promise.all(
      (
        [
          { artifact: "bundle", file: manifest.tree.bundle },
          { artifact: "patch", file: manifest.tree.patch },
          { artifact: "conversation", file: manifest.conversation },
          // A Codex session's raw rollout, when its Snapshot has one.
          ...(manifest.rollout ? [{ artifact: "rollout" as const, file: manifest.rollout }] : []),
        ] as const
      ).map(async ({ artifact, file }) => ({
        artifact,
        url: await mintSnapshotDownloadUrl(storage, `${storagePath}${file}`, owner.id),
        // An imported session's artifacts are stored compressed.
        ...(manifest.encodings?.[file] && { encoding: manifest.encodings[file] }),
      })),
    );
    // Its other chats, each with its conversation, those it still has: one
    // deleted since it was archived stays gone.
    const keptChats = await listChatsOf(workspace.id);
    const chats = await restoreChats(manifest, keptChats, (file) =>
      mintSnapshotDownloadUrl(storage, `${storagePath}${file}`, owner.id),
    );

    // If the persisted box is marked ready but its Daytona sandbox has
    // vanished, release the stale claim first so ensure provisions a replacement
    // — otherwise restore would fail instead of rebuilding on a fresh box (the
    // whole point of portable Restore). Mirrors the create flow.
    // The box that ended (paused while idle, or once its last session was
    // archived), for a provider that brings it back on the disk it left, so
    // the restore resumes it rather than leaving it behind for a new one.
    let endedBox = endedBoxOf(currentComputer, provider.name);
    if (
      currentComputer?.status === "ready" &&
      currentComputer.daytonaSandboxId &&
      !(await provider.computerAlive(currentComputer.daytonaSandboxId))
    ) {
      await markRuntimeComputerStoppedIfReady(
        currentComputer.id,
        currentComputer.ownerId,
        currentComputer.daytonaSandboxId,
      );
      endedBox = currentComputer.daytonaSandboxId;
    }

    // How the session's agent signs in, as the user picks now, and the model
    // it goes back on, its key fetched now: before a box is started for it,
    // so a pick that can't run, or a key removed, starts nothing.
    const { auth, restoreOn } = await restoreSignIn(workspace, owner.id);
    const model = restoreOn
      ? await recordedModelRequest(restoreOn, (holder) => modelKey(owner.id, holder, project.orgId))
      : undefined;

    // Ensure a box (any) and refresh its mirror before the agent branches from
    // the bundle. Matches the create flow's lazy-provision path.
    const sessionEnv = await runtimeSessionEnvironment(owner.id, workspace.id);
    const ensured = await ensureComputer(provider, {
      scope,
      repoFullName: project.fullName,
      githubToken,
      sessionEnv,
      // The plan's box cap, enforced by the claim in the database.
      maxLiveComputers: gate.cap,
      ...(provider.restoresBoxes && endedBox && { previousSandboxId: endedBox }),
    });
    const computer = ensured.computer;
    if (!computer.daytonaSandboxId) {
      throw new Error("Ready Runtime Computer has no sandbox id.");
    }
    if (!ensured.provisioned) {
      await provider.fetchMirror(computer.daytonaSandboxId, githubToken);
    }

    const target = await provider.agentTarget(
      computer.daytonaSandboxId,
      ensured.agentSecret,
    );
    const identity: WorkspaceIdentity = {
      workspaceId: workspace.id,
      projectId: project.id,
      computerId: computer.id,
      userId: owner.id,
    };
    const agent = new AgentClient(target);
    // The restore relaunches the session at once, so its credential rides
    // with it; checked first, as is that the box runs the session's agent
    // (an agent too old for Codex would make a Claude Code session of it).
    const upgrade = boxUpgrade(provider, computer.daytonaSandboxId, ensured.agentSecret, owner.id, workspace.id);
    const features = { features: async () => (await agent.health(identity)).features ?? [], upgrade };
    if (manifest.origin) {
      await requireFeature(features, AGENT_FEATURE_IMPORTS, "restore a session imported from a Mac");
    }
    if (workspace.checkouts) {
      await requireFeature(features, AGENT_FEATURE_MULTI_REPO_SNAPSHOTS, "restore a session of several repositories");
    }
    if (chats.length > 0) {
      await requireFeature(features, AGENT_FEATURE_CHAT_SNAPSHOTS, "restore a session with several chats");
    }
    // An older agent would ignore the model, and relaunch on Claude's own.
    if (model) await requireFeature(features, AGENT_FEATURE_RESTORE_MODEL, "restore a session on its model");
    // Nor would one from before Codex ran through a gateway take its model.
    if (restoreOn && onCodexGateway(workspace.agent, restoreOn.model)) {
      await requireFeature(features, AGENT_FEATURE_CODEX_GATEWAY, "run Codex on Outrunner's models");
    }
    const tree = manifest.tree;
    // A session of several repositories: a mirror of each, its bundle's
    // commits imported into it by the restore. After the checks: none is
    // fetched for a box that can't restore it.
    if (workspace.checkouts) {
      await provider.syncRepoMirrors(
        computer.daytonaSandboxId,
        workspace.checkouts.map((c) => ({ fullName: c.fullName, checkout: c.checkout })),
        gitTokensFor(owner.id, project.orgId, as),
      );
    }
    // Before the restore, which launches the session at once.
    await setUpSession(agent, identity, upgrade, owner.id, project.id, workspace.environmentId, { agent: workspace.agent });
    const bundleRef = tree.kind === "git-bundle+patch" && tree.ref && tree.ref !== workspace.branch ? tree.ref : undefined;
    let restoredWorktree: string | undefined;
    await restoreSignedIn(sessionAuthClient(agent, identity, upgrade), workspace.agent, auth, async (credential) => {
      const restored = await agent.restoreWorkspace(identity, {
        branch: workspace.branch,
        // The session's own base (a PR review's, an API session's), which
        // the Changes diff and Claude's orientation go by; not the project's.
        baseBranch: workspace.baseBranch || project.defaultBranch,
        sessionId: manifest.sessionId,
        downloads,
        ...(workspace.agent !== "claude" && { agent: workspace.agent }),
        ...(credential && { auth: credential }),
        ...(model && { model }),
        ...(bundleRef && { bundleRef }),
        ...(manifest.origin && { originWorktree: manifest.origin.worktree }),
        ...(workspace.checkouts && {
          repos: workspace.checkouts.map((c) => ({ fullName: c.fullName, checkout: c.checkout, baseBranch: c.baseBranch })),
        }),
        ...(chats.length > 0 && { chats }),
      });
      restoredWorktree = restored.worktree;
    });
    // Each chat back signed in on its own agent and model, as it is opened
    // next: one on the other agent than the session has no credential yet.
    // Best effort: a chat that can't sign in now says why when it is opened.
    for (const chat of keptChats.filter((kept) => chats.some((c) => c.chatId === kept.id))) {
      await readyChatRelaunch(agent, identity, upgrade, { orgId: project.orgId }, chat, owner.id).catch((error: unknown) =>
        console.warn(`Restore: chat ${chat.id} of ${workspace.id} isn't signed in yet`, error),
      );
    }

    // Persist the (possibly new) box + session linkage now that the agent has
    // rebuilt and verified the worktree. Its path too, which a session
    // imported from a Mac has none of; an older agent doesn't report it, and
    // the one on record (if any) is kept.
    await updateWorkspace(workspace.id, workspace.ownerId, {
      computerId: computer.id,
      tmuxSession: `ws-${workspace.id}`,
      agentWorkspaceId: workspace.id,
      ...(restoredWorktree && { worktreePath: restoredWorktree }),
    });
    // One from before models were recorded now has one.
    if (restoreOn && !workspace.model) await recordWorkspaceModel(workspace.id, workspace.ownerId, restoreOn);
  } catch (error) {
    const failure = signInFailure(error);
    if (!failure) console.error(`Workspace ${workspace.id} restore failed`, error);
    const message = failure?.error ?? lifecycleError("restore");
    await restoreAfterFailure(workspace, "restoring", message).catch(
      (updateError: unknown) => console.error("Could not persist restore failure", updateError),
    );
    // The plan's cap can refuse a start mid-flight (a simultaneous start won
    // the slot first): say so, rather than blame the restore.
    const refused = isPlanLimitError(error);
    if (refused) return NextResponse.json({ error: refused.message, settingsHref: UPGRADE_HREF }, { status: 403 });
    return NextResponse.json(failure ?? { error: message }, { status: failure ? 409 : 502 });
  }

  const completed = await completeTransition({
    id: workspace.id,
    ownerId: workspace.ownerId,
    from: "restoring",
    patch: { status: "ready", errorMessage: null, touchActive: true },
  });
  return completed
    ? NextResponse.json({ workspace: { id: workspace.id, status: "ready" } })
    : lifecycleReconciliationRequired("restore");
}

/**
 * How a session being restored signs in, and the model it goes back on: the
 * one its row records, or, for a session from before models were recorded,
 * the user's Claude when it signs in there, else the model a new session
 * would start on (Outrunner's, or one on the user's key). With neither, the
 * user is told to connect Claude.
 */
async function restoreSignIn(
  workspace: Workspace,
  ownerId: string,
): Promise<{ auth: ResolvedAuth; restoreOn: RecordedModel | null }> {
  const store = agentAuthStore(ownerId, workspace.orgId);
  const ownAccount = relaunchNeedsAccount(workspace.agent, workspace.model);
  const auth = await resolveAgentAuth(store, workspace.agent, "cloud", { ownAccount });
  if (workspace.model || auth.credential || workspace.agent !== "claude") {
    return { auth, restoreOn: workspace.model };
  }
  const fallback = defaultModel(await modelMenu(ownerId, workspace.orgId));
  // Nothing to run on: this says what to connect.
  if (!fallback) await resolveAgentAuth(store, workspace.agent, "cloud");
  return { auth, restoreOn: fallback && { model: fallback, effort: null } };
}

async function resumeDaytonaWorkspace(
  workspace: Workspace,
  provider: ComputerRuntimeProvider,
  owner: Owner,
) {
  if (workspace.status !== "suspended") {
    return NextResponse.json(
      { error: "Only a suspended workspace can be resumed." },
      { status: 409 },
    );
  }
  const transitioned = await startTransition(workspace, ["suspended"], "resuming");
  if (!transitioned) return lifecycleConflict();
  let stage: ResumeStage = "box";
  try {
    // Nothing runs on a suspended session's box, so it is paused once idle
    // (lib/billing/reconcile.ts), or the provider may have stopped, archived
    // or deleted it: brought back first, as opening the session does.
    const computer = await getWorkspaceComputer(workspace);
    if (computer && provider.restoresBoxes) await bringBack(provider, workspace, computer, owner);
    stage = "relaunch";
    // ensureComputer updates the row in place; daytonaAgent reads it again
    // so a replacement box is used rather than this earlier computer value.
    const { agent, identity, upgrade, sandboxId, secret } = await daytonaAgent(workspace, provider, owner);
    // Signed in as the user picks now, and on its model's key as it is now,
    // before it relaunches.
    await withRuntimeAgentRecovery(
      { provider, sandboxId, secret, agent, identity, upgrade, workspaceId: workspace.id },
      async (current) => {
        await readyRelaunch(current, identity, upgrade, workspace, owner.id);
        await current.resumeWorkspace(identity);
      },
    );
  } catch (error) {
    const failure = resumeFailure(error, stage);
    if (failure.status !== 403 && (stage === "box" || failure.status !== 409)) {
      console.error(`Workspace ${workspace.id} resume failed during ${stage}`, error);
    }
    await restoreAfterFailure(workspace, "resuming", failure.body.error).catch(
      (updateError: unknown) => console.error("Could not persist resume failure", updateError),
    );
    return NextResponse.json(failure.body, { status: failure.status });
  }
  const completed = await completeTransition({
    id: workspace.id,
    ownerId: workspace.ownerId,
    from: "resuming",
    patch: { status: "ready", errorMessage: null, touchActive: true },
  });
  return completed
    ? NextResponse.json({ workspace: { id: workspace.id, status: "ready" } })
    : lifecycleReconciliationRequired("resume");
}

async function suspendDaytonaWorkspace(
  workspace: Workspace,
  provider: ComputerRuntimeProvider,
  owner: Owner,
) {
  if (workspace.status !== "ready" && workspace.status !== "idle") {
    return NextResponse.json(
      { error: "Only an active workspace can be suspended." },
      { status: 409 },
    );
  }
  const transitioned = await startTransition(workspace, ["ready", "idle"], "suspending");
  if (!transitioned) return lifecycleConflict();
  try {
    const { agent, identity } = await daytonaAgent(workspace, provider, owner);
    await agent.stopWorkspace(identity);
  } catch (error) {
    console.error(`Workspace ${workspace.id} suspend failed`, error);
    await restoreAfterFailure(workspace, "suspending", lifecycleError("suspend")).catch(
      (updateError: unknown) => console.error("Could not persist suspend failure", updateError),
    );
    return NextResponse.json({ error: lifecycleError("suspend") }, { status: 502 });
  }
  const completed = await completeTransition({
    id: workspace.id,
    ownerId: workspace.ownerId,
    from: "suspending",
    patch: { status: "suspended", errorMessage: null },
  });
  return completed
    ? NextResponse.json({ workspace: { id: workspace.id, status: "suspended" } })
    : lifecycleReconciliationRequired("suspend");
}

async function destroyDaytonaWorkspace(
  workspace: Workspace,
  provider: ComputerRuntimeProvider,
  owner: Owner,
) {
  const response = await endWorkspace(workspace, async () => {
    const { agent, identity } = await daytonaAgent(workspace, provider, owner);
    await agent.destroyWorkspace(identity);
  });
  // Its own box goes with it; the last session off a shared box pauses it.
  if (response.ok) after(() => releaseWorkspaceBox(provider, workspace, true));
  return response;
}

/**
 * Destroy a workspace for good: its worktree first, through `teardown` (none
 * when its box can't be reached from here), then its snapshot index and the
 * row itself, marked destroyed.
 */
async function endWorkspace(workspace: Workspace, teardown?: () => Promise<void>) {
  if (!canDestroy(workspace, Date.now())) {
    return NextResponse.json(
      { error: "This workspace cannot be destroyed while another lifecycle action is running." },
      { status: 409 },
    );
  }
  // Only from the status just checked: one that moved since is another change.
  const transitioned = await startTransition(workspace, [workspace.status], "destroying");
  if (!transitioned) return lifecycleConflict();

  // Best-effort worktree teardown: destroy is terminal, and the box may
  // already be gone (e.g. destroying an ARCHIVED workspace whose Runtime Computer
  // was reclaimed). A missing/failed agent must not block the durable cleanup.
  try {
    await teardown?.();
  } catch (error) {
    console.warn(`Workspace ${workspace.id} agent teardown skipped`, error);
  }

  // Drop the Snapshot index rows: the workspace row is marked destroyed rather
  // than deleted, so the FK cascade never fires — remove them explicitly so a
  // destroyed workspace retains no replay metadata.
  await deleteWorkspaceSnapshots(workspace.id).catch((error: unknown) =>
    console.error(`Could not delete snapshots for ${workspace.id}`, error),
  );
  // And the copies the chat kept of its box's images (lib/db/chat-images.ts).
  await deleteCachedBoxImages(workspace.id).catch((error: unknown) =>
    console.error(`Could not delete kept box images for ${workspace.id}`, error),
  );
  // And the first prompt kept for it while its box started, which has nothing
  // left to be delivered to: nothing of the session waits on the row.
  await clearWorkspaceFirstPrompt(workspace.id, workspace.ownerId).catch((error: unknown) =>
    console.error(`Could not drop the kept first prompt of ${workspace.id}`, error),
  );

  const completed = await completeTransition({
    id: workspace.id,
    ownerId: workspace.ownerId,
    from: "destroying",
    patch: {
      status: "destroyed",
      sandboxId: null,
      volumeName: null,
      worktreePath: null,
    },
  });
  return completed
    ? NextResponse.json({ workspace: { id: workspace.id, status: "destroyed" } })
    : lifecycleReconciliationRequired("destroy");
}

async function resumeWorkspace(workspace: Workspace, provider: RuntimeProvider) {
  if (workspace.status !== "suspended" || !workspace.volumeName) {
    return NextResponse.json(
      { error: "Only a suspended workspace with persistent storage can be resumed." },
      { status: 409 },
    );
  }
  const transitioned = await startTransition(workspace, ["suspended"], "resuming");
  if (!transitioned) return lifecycleConflict();

  let sandboxId: string;
  try {
    const result = await provider.resumeWorkspace({
      workspaceId: workspace.id,
      volumeName: workspace.volumeName,
      env: {},
    });
    sandboxId = result.sandboxId;
  } catch (error) {
    console.error(`Workspace ${workspace.id} resume failed`, error);
    await restoreAfterFailure(workspace, "resuming", lifecycleError("resume")).catch(
      (updateError: unknown) => console.error("Could not persist resume failure", updateError),
    );
    return NextResponse.json({ error: lifecycleError("resume") }, { status: 502 });
  }

  try {
    const completed = await completeTransition({
      id: workspace.id,
      ownerId: workspace.ownerId,
      from: "resuming",
      patch: {
        status: "ready",
        sandboxId,
        errorMessage: null,
        touchActive: true,
      },
    });
    if (completed) {
      return NextResponse.json({ workspace: { id: workspace.id, status: "ready" } });
    }
  } catch (error) {
    console.error(`Workspace ${workspace.id} resume completion failed`, error);
  }
  return lifecycleReconciliationRequired("resume");
}

async function suspendWorkspace(workspace: Workspace, provider: RuntimeProvider) {
  if (
    (workspace.status !== "ready" && workspace.status !== "idle") ||
    !workspace.sandboxId
  ) {
    return NextResponse.json(
      { error: "Only an active workspace can be suspended." },
      { status: 409 },
    );
  }
  // Interactive Runtime no longer derives lifecycle state from the jobs table:
  // the runtime-agent (tmux + Claude session) is the source of truth for active
  // execution, so suspend/destroy decide on the Runtime Computer's live session.
  // Legacy batch job rows are intentionally ignored — do NOT reintroduce a
  // jobs-table guard (e.g. hasActiveJob) here.
  const transitioned = await startTransition(workspace, ["ready", "idle"], "suspending");
  if (!transitioned) return lifecycleConflict();

  try {
    await provider.suspendWorkspace({
      workspaceId: workspace.id,
      sandboxId: workspace.sandboxId,
    });
  } catch (error) {
    console.error(`Workspace ${workspace.id} suspend failed`, error);
    await restoreAfterFailure(workspace, "suspending", lifecycleError("suspend")).catch(
      (updateError: unknown) => console.error("Could not persist suspend failure", updateError),
    );
    return NextResponse.json({ error: lifecycleError("suspend") }, { status: 502 });
  }

  try {
    const completed = await completeTransition({
      id: workspace.id,
      ownerId: workspace.ownerId,
      from: "suspending",
      patch: { status: "suspended", sandboxId: null, errorMessage: null },
    });
    if (completed) {
      return NextResponse.json({ workspace: { id: workspace.id, status: "suspended" } });
    }
  } catch (error) {
    console.error(`Workspace ${workspace.id} suspend completion failed`, error);
  }
  return lifecycleReconciliationRequired("suspend");
}

async function destroyWorkspace(workspace: Workspace, provider: RuntimeProvider) {
  if (!canDestroy(workspace, Date.now())) {
    return NextResponse.json(
      { error: "This workspace cannot be destroyed while another lifecycle action is running." },
      { status: 409 },
    );
  }
  // Legacy batch job rows are intentionally ignored here too — runtime-agent, not
  // the jobs table, owns active-execution state (see suspendWorkspace).
  const transitioned = await startTransition(workspace, [workspace.status], "destroying");
  if (!transitioned) return lifecycleConflict();

  try {
    await provider.destroyWorkspace({
      workspaceId: workspace.id,
      sandboxId: workspace.sandboxId,
      volumeName: workspace.volumeName,
    });
  } catch (error) {
    console.error(`Workspace ${workspace.id} destroy failed`, error);
    await restoreAfterFailure(workspace, "destroying", lifecycleError("destroy")).catch(
      (updateError: unknown) => console.error("Could not persist destroy failure", updateError),
    );
    return NextResponse.json({ error: lifecycleError("destroy") }, { status: 502 });
  }
  await deleteCachedBoxImages(workspace.id).catch((error: unknown) =>
    console.error(`Could not delete kept box images for ${workspace.id}`, error),
  );
  // As endWorkspace: a first prompt kept while its box started has nothing
  // left to be delivered to once the session is gone.
  await clearWorkspaceFirstPrompt(workspace.id, workspace.ownerId).catch((error: unknown) =>
    console.error(`Could not drop the kept first prompt of ${workspace.id}`, error),
  );

  try {
    const completed = await completeTransition({
      id: workspace.id,
      ownerId: workspace.ownerId,
      from: "destroying",
      patch: {
        status: "destroyed",
        sandboxId: null,
        volumeName: null,
        worktreePath: null,
      },
    });
    if (completed) {
      return NextResponse.json({ workspace: { id: workspace.id, status: "destroyed" } });
    }
  } catch (error) {
    console.error(`Workspace ${workspace.id} destroy completion failed`, error);
  }
  return lifecycleReconciliationRequired("destroy");
}

function lifecycleConflict() {
  return NextResponse.json(
    { error: "This workspace changed in another session. Refresh and try again." },
    { status: 409 },
  );
}

function lifecycleReconciliationRequired(action: LifecycleAction) {
  return NextResponse.json(
    {
      error: `${action[0].toUpperCase()}${action.slice(1)} completed, but Outrunner could not save its final state. Refresh before trying another action.`,
    },
    { status: 503 },
  );
}

/** Whether a Snapshot's tree holds the session's repositories: a tree of one
 *  for a session of one, the same checkout folders for a session of several. */
function snapshotMatchesSession(tree: SnapshotManifest["tree"], checkouts: Workspace["checkouts"]): boolean {
  const inSnapshot = tree.kind === "git-bundles+patches" ? tree.checkouts.map((c) => c.name).toSorted() : null;
  const inSession = checkouts?.map((c) => c.checkout).toSorted() ?? null;
  return JSON.stringify(inSnapshot) === JSON.stringify(inSession);
}
