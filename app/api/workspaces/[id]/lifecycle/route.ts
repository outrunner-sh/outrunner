import { after, NextResponse } from "next/server";

import { resolveAgentAuth, type ResolvedAuth } from "@/lib/agents/resolve";
import { getOwner, type Owner } from "@/lib/auth/owner";
import { cloudBoxStartGate, isPlanLimitError, UPGRADE_HREF } from "@/lib/billing/limits";
import { releaseWorkspaceBox } from "@/lib/billing/release-box.deps";
import { agentAuthStore, modelKey, modelMenu } from "@/lib/db/credentials";
import { optionalGithubToken } from "@/lib/github/token";
import {
  createWorkspaceSnapshot,
  deleteWorkspaceSnapshots,
  getProject,
  getWorkspaceComputer,
  getWorkspace,
  listWorkspaceSnapshots,
  markRuntimeComputerStoppedIfReady,
  readRuntimeComputerSecret,
  recordWorkspaceModel,
  transitionWorkspace,
  updateWorkspace,
} from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_IMPORTS, AGENT_FEATURE_RESTORE_MODEL } from "@/lib/runtime/agent-protocol";
import { requireFeature } from "@/lib/runtime/box-features";
import { setUpSession } from "@/lib/runtime/session-setup.deps";
import { isComputerProvider, type ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { scopeOf } from "@/lib/runtime/computer-scope";
import { recordedModelRequest } from "@/lib/runtime/model-switch";
import { readyRelaunch } from "@/lib/runtime/relaunch.deps";
import { relaunchNeedsAccount, restoreSignedIn, sessionAuthClient, signInFailure } from "@/lib/runtime/session-auth";
import { defaultModel, type RecordedModel } from "@/lib/runtime/session-models";
import { boxUpgrade, runtimeSessionEnvironment } from "@/lib/runtime/session-environment";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import { ensureComputer } from "@/lib/runtime/runtime-computer-service";
import { endedBoxOf } from "@/lib/runtime/sandbox-choice";
import { mintSnapshotDownloadUrl, mintSnapshotUpload } from "@/lib/runtime/storage";
import { supabaseSnapshotStorage } from "@/lib/runtime/storage/supabase-adapter";
import type { RuntimeProvider, Workspace, WorkspaceStatus } from "@/lib/runtime/types";
import { canDestroy } from "@/lib/session/provisioning";

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
    from,
    patch: { status, errorMessage: null },
  });
}

async function restoreAfterFailure(
  workspace: Workspace,
  transitionStatus: WorkspaceStatus,
  message: string,
): Promise<void> {
  await transitionWorkspace({
    id: workspace.id,
    from: [transitionStatus],
    patch: { status: workspace.status, errorMessage: message },
  });
}

async function completeTransition(input: {
  id: string;
  from: WorkspaceStatus;
  patch: Parameters<typeof transitionWorkspace>[0]["patch"];
}): Promise<boolean> {
  return Boolean(
    await transitionWorkspace({
      id: input.id,
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
  try {
    action = actionFor(await request.json());
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
    return daytonaLifecycle(action, workspace, provider, owner);
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
) {
  if (action === "resume") return resumeDaytonaWorkspace(workspace, provider, owner);
  if (action === "suspend") return suspendDaytonaWorkspace(workspace, provider, owner);
  if (action === "archive") return archiveDaytonaWorkspace(workspace, provider, owner);
  if (action === "restore") return restoreDaytonaWorkspace(workspace, provider, owner);
  return destroyDaytonaWorkspace(workspace, provider, owner);
}

/**
 * Archive → produce a Workspace Snapshot. Next mints one signed upload URL per
 * artifact, the agent captures + uploads them (manifest last) and returns the
 * manifest, then Next caches it on a `workspace_snapshots` row and marks the
 * workspace `archived`. The worktree is intentionally kept (Restore reclaims it
 * later), so an archived workspace is revivable — not destroyed.
 */
async function archiveDaytonaWorkspace(
  workspace: Workspace,
  provider: ComputerRuntimeProvider,
  owner: Owner,
) {
  if (workspace.status !== "ready" && workspace.status !== "idle") {
    return NextResponse.json(
      { error: "Only an active workspace can be archived." },
      { status: 409 },
    );
  }
  const transitioned = await startTransition(workspace, ["ready", "idle"], "archiving");
  if (!transitioned) return lifecycleConflict();

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

    const { agent, identity } = await daytonaAgent(workspace, provider, owner);
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
    await restoreAfterFailure(workspace, "archiving", lifecycleError("archive")).catch(
      (updateError: unknown) => console.error("Could not persist archive failure", updateError),
    );
    return NextResponse.json({ error: lifecycleError("archive") }, { status: 502 });
  }

  const completed = await completeTransition({
    id: workspace.id,
    from: "archiving",
    patch: { status: "archived", errorMessage: null },
  });
  // The last session off its box frees it: paused now, not when idle.
  if (completed) after(() => releaseWorkspaceBox(provider, workspace, false));
  return completed
    ? NextResponse.json({ workspace: { id: workspace.id, status: "archived" } })
    : lifecycleReconciliationRequired("archive");
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
    return NextResponse.json(
      { error: "This workspace has no Snapshot to restore." },
      { status: 409 },
    );
  }
  // The box it restores on: its own (paused when it was archived), or, for a
  // session from before each had its own, its project's shared one.
  const currentComputer = await getWorkspaceComputer(workspace);
  const scope = scopeOf(workspace, currentComputer);
  // A box may be about to start (the box may be gone): the plan's hours and
  // box count get their say before anything changes.
  const gate = await cloudBoxStartGate(owner, provider.name, scope);
  if ("denial" in gate) return NextResponse.json(gate.denial, { status: 403 });
  const transitioned = await startTransition(workspace, ["archived"], "restoring");
  if (!transitioned) return lifecycleConflict();

  try {
    const project = await getProject(workspace.projectId);
    if (!project) throw new Error("Project not found for restore.");
    const githubToken = await optionalGithubToken(owner.id);

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
        currentComputer.daytonaSandboxId,
      );
      endedBox = currentComputer.daytonaSandboxId;
    }

    // How the session's agent signs in, as the user picks now, and the model
    // it goes back on, its key fetched now: before a box is started for it,
    // so a pick that can't run, or a key removed, starts nothing.
    const { auth, restoreOn } = await restoreSignIn(workspace, owner.id);
    const model = restoreOn ? await recordedModelRequest(restoreOn, (holder) => modelKey(owner.id, holder)) : undefined;

    // Ensure a box (any) and refresh its mirror before the agent branches from
    // the bundle. Matches the create flow's lazy-provision path.
    const sessionEnv = await runtimeSessionEnvironment(owner.id);
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
    const upgrade = boxUpgrade(provider, computer.daytonaSandboxId, ensured.agentSecret, owner.id);
    const features = { features: async () => (await agent.health(identity)).features ?? [], upgrade };
    if (manifest.origin) {
      await requireFeature(features, AGENT_FEATURE_IMPORTS, "restore a session imported from a Mac");
    }
    // An older agent would ignore the model, and relaunch on Claude's own.
    if (model) await requireFeature(features, AGENT_FEATURE_RESTORE_MODEL, "restore a session on its model");
    // Before the restore, which launches the session at once.
    await setUpSession(agent, identity, upgrade, owner.id, project.id);
    const bundleRef = manifest.tree.ref && manifest.tree.ref !== workspace.branch ? manifest.tree.ref : undefined;
    let restoredWorktree: string | undefined;
    await restoreSignedIn(sessionAuthClient(agent, identity, upgrade), workspace.agent, auth, async (credential) => {
      const restored = await agent.restoreWorkspace(identity, {
        branch: workspace.branch,
        baseBranch: project.defaultBranch,
        sessionId: manifest.sessionId,
        downloads,
        ...(workspace.agent !== "claude" && { agent: workspace.agent }),
        ...(credential && { auth: credential }),
        ...(model && { model }),
        ...(bundleRef && { bundleRef }),
        ...(manifest.origin && { originWorktree: manifest.origin.worktree }),
      });
      restoredWorktree = restored.worktree;
    });

    // Persist the (possibly new) box + session linkage now that the agent has
    // rebuilt and verified the worktree. Its path too, which a session
    // imported from a Mac has none of; an older agent doesn't report it, and
    // the one on record (if any) is kept.
    await updateWorkspace(workspace.id, {
      computerId: computer.id,
      tmuxSession: `ws-${workspace.id}`,
      agentWorkspaceId: workspace.id,
      ...(restoredWorktree && { worktreePath: restoredWorktree }),
    });
    // One from before models were recorded now has one.
    if (restoreOn && !workspace.model) await recordWorkspaceModel(workspace.id, restoreOn);
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
  const store = agentAuthStore(ownerId);
  const ownAccount = relaunchNeedsAccount(workspace.agent, workspace.model);
  const auth = await resolveAgentAuth(store, workspace.agent, "cloud", { ownAccount });
  if (workspace.model || auth.credential || workspace.agent !== "claude") {
    return { auth, restoreOn: workspace.model };
  }
  const fallback = defaultModel(await modelMenu(ownerId));
  // Nothing to run on: this says what to connect.
  if (!fallback) await resolveAgentAuth(store, workspace.agent, "cloud");
  return { auth, restoreOn: fallback && { model: fallback, effort: null } };
}

async function daytonaAgent(
  workspace: Workspace,
  provider: ComputerRuntimeProvider,
  owner: Owner,
): Promise<{ agent: AgentClient; identity: WorkspaceIdentity; upgrade?: () => Promise<void> }> {
  const computer = await getWorkspaceComputer(workspace);
  if (!computer?.daytonaSandboxId || computer.status !== "ready") {
    throw new Error("Runtime Computer is not available.");
  }
  const secret = await readRuntimeComputerSecret(computer.id);
  if (!secret) throw new Error("Runtime Computer secret is missing.");
  const target = await provider.agentTarget(computer.daytonaSandboxId, secret);
  return {
    upgrade: boxUpgrade(provider, computer.daytonaSandboxId, secret, owner.id),
    agent: new AgentClient(target),
    identity: {
      workspaceId: workspace.id,
      projectId: workspace.projectId,
      computerId: computer.id,
      userId: owner.id,
    },
  };
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
  try {
    const { agent, identity, upgrade } = await daytonaAgent(workspace, provider, owner);
    // Signed in as the user picks now, and on its model's key as it is now,
    // before it relaunches.
    await readyRelaunch(agent, identity, upgrade, workspace, owner.id);
    await agent.resumeWorkspace(identity);
  } catch (error) {
    const failure = signInFailure(error);
    if (!failure) console.error(`Workspace ${workspace.id} resume failed`, error);
    const message = failure?.error ?? lifecycleError("resume");
    await restoreAfterFailure(workspace, "resuming", message).catch(
      (updateError: unknown) => console.error("Could not persist resume failure", updateError),
    );
    return NextResponse.json(failure ?? { error: message }, { status: failure ? 409 : 502 });
  }
  const completed = await completeTransition({
    id: workspace.id,
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

  const completed = await completeTransition({
    id: workspace.id,
    from: "destroying",
    patch: {
      status: "destroyed",
      sandboxId: null,
      volumeName: null,
      worktreePath: null,
      errorMessage: null,
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

  try {
    const completed = await completeTransition({
      id: workspace.id,
      from: "destroying",
      patch: {
        status: "destroyed",
        sandboxId: null,
        volumeName: null,
        worktreePath: null,
        errorMessage: null,
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
