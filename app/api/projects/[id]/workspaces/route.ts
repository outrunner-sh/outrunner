import { randomUUID } from "node:crypto";

import { after, NextResponse } from "next/server";

import type { AgentId } from "@/lib/agents/registry";
import { AgentAuthError, resolveAgentAuth, type ResolvedAuth } from "@/lib/agents/resolve";
import { getOwner, type Owner } from "@/lib/auth/owner";
import { planFor } from "@/lib/billing/entitlements";
import { cloudBoxStartGate, isPlanLimitError } from "@/lib/billing/limits";
import {
  agentAuthStore,
  getSandboxSettings,
  modelKey,
  modelMenu,
  offersModels,
  ownSandboxKeys,
  type SandboxSettings,
} from "@/lib/db/credentials";
import {
  createWorkspaceRow,
  getProject,
  getRuntimeComputer,
  liveWorkspaceOnBranch,
  markRuntimeComputerStoppedIfReady,
  recordWorkspaceModel,
  transitionWorkspace,
} from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { modelKeyErrorResponse } from "@/lib/http/model-key-errors";
import { branchTakenResponse, isUniqueViolation, workspaceCreateErrorResponse } from "@/lib/http/workspace-create-errors";
import { workspaceLabel } from "@/lib/nav/session-title";
import { NoProviderKeyError } from "@/lib/providers/errors";
import { isProviderId } from "@/lib/providers/registry";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { NoDaytonaKeyError } from "@/lib/runtime/daytona-provider";
import { isValidBranchName } from "@/lib/runtime/git";
import { provisionFailureMessage } from "@/lib/runtime/provision-failure";
import { setUpSession } from "@/lib/runtime/session-setup.deps";
import { NO_OUTRUNNER_MODELS, NoStartingModelError, startingModel } from "@/lib/runtime/model-switch";
import {
  agentOf,
  defaultModel,
  type Effort,
  EffortUnsupportedError,
  requestedEffort,
  requestedModel,
  runsOnOwnAccount,
  type SessionModel,
} from "@/lib/runtime/session-models";
import {
  deliverSessionAuth,
  OutdatedComputerError,
  readyBox,
  sessionAuthClient,
} from "@/lib/runtime/session-auth";
import {
  boxSizeOn,
  computerMadeBy,
  endedBoxOf,
  providerForNewSessions,
  retireComputer,
} from "@/lib/runtime/sandbox-choice";
import { NoModalTokenError } from "@/lib/runtime/user-modal-provider";
import { boxUpgrade, runtimeSessionEnvironment } from "@/lib/runtime/session-environment";
import { ensureComputer } from "@/lib/runtime/runtime-computer-service";
import type { Project, ProvisionPhase, RuntimeProvider, Workspace } from "@/lib/runtime/types";
import { SETTING_UP } from "@/lib/session/provisioning";
import { optionalGithubToken } from "@/lib/github/token";
import { workspaceCloneEnvironment } from "@/lib/runtime/workspace-environment";
import { PROVIDERS_SETTINGS_HREF, providerSettingsHref } from "@/lib/settings-links";

// Lazy provisioning boots a Daytona box + agent (~15s) plus a repo mirror, in
// after() once the response has gone. maxDuration caps the per-request
// wall-clock, after() included, on serverless hosts (a no-op on a long-running
// server like Railway); 60s covers provisioning with headroom.
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

function generatedBranch(): string {
  return `runtime/${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/** The session can't run without the user's Claude: say so, and where to fix it. */
function needsClaude(error: string) {
  return NextResponse.json({ error, settingsHref: providerSettingsHref("claude") }, { status: 409 });
}

function needsSandbox(error: string) {
  return NextResponse.json({ error, settingsHref: "/settings/sandbox" }, { status: 409 });
}

/** Create one local worktree from a Runtime project. */
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

  const { id } = await context.params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  let body: { branch?: unknown; provider?: unknown; model?: unknown; key?: unknown; effort?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  // The model chosen on the new-session screen; none, the menu's default.
  const chosenModel = requestedModel(body);
  if (chosenModel === null) {
    return NextResponse.json({ error: "Choose one of the offered models." }, { status: 400 });
  }
  // Picked with it; none, the model's own.
  const chosenEffort = requestedEffort(body);
  if (chosenEffort === null) {
    return NextResponse.json({ error: "Choose one of the offered efforts." }, { status: 400 });
  }
  // Codex for Codex's models, Claude Code for every other, and for none.
  const agentId = agentOf(chosenModel?.provider ?? "claude");
  const menu = await modelMenu(owner.id);
  // What it starts on: the model chosen, else the menu's default, else the
  // user's Claude (startingModel). On a model on a key, Claude Code needs no
  // account of the user's: one they haven't connected doesn't stop it.
  const startsOn = chosenModel ?? defaultModel(menu);
  const ownAccount = !startsOn || runsOnOwnAccount(startsOn);
  // How it signs in, said before a box is set up for it, not after.
  let auth: ResolvedAuth;
  try {
    auth = await resolveAgentAuth(agentAuthStore(owner.id), agentId, "cloud", { ownAccount });
  } catch (error) {
    if (!(error instanceof AgentAuthError)) throw error;
    return NextResponse.json({ error: error.message, settingsHref: error.settingsHref }, { status: 409 });
  }

  const githubToken = await optionalGithubToken(owner.id);
  const sessionEnv = await runtimeSessionEnvironment(owner.id);
  // Whether it can run on the user's Claude: only as they picked it (or, with
  // no pick, on what they saved), which `auth` holds. Never on the box's own
  // environment instead, which may hold a key the user didn't pick, or one
  // since removed: a session falling back on it would be billed to the wrong
  // account. Sessions start on Outrunner's models (on the user's own
  // OpenRouter key, or the server's), so only without those is Claude a
  // must. Codex runs on its own sign-in, resolved above.
  const hasClaude = agentId === "claude" && auth.credential !== null;
  if (agentId === "claude" && !hasClaude && !offersModels(menu)) {
    return NextResponse.json({ error: NO_OUTRUNNER_MODELS, settingsHref: PROVIDERS_SETTINGS_HREF }, { status: 409 });
  }
  if (project.private && !githubToken) {
    return NextResponse.json(
      {
        error:
          "Connect your GitHub account to clone a private repository: sign out and back in to grant repository access.",
      },
      { status: 409 },
    );
  }

  // Said before a box is set up for it, not after.
  if (chosenModel?.provider === "claude" && !hasClaude) {
    return needsClaude("Connect Claude to start a session on your Claude account.");
  }
  if (chosenModel && isProviderId(chosenModel.provider) && !menu.keys.includes(chosenModel.provider)) {
    return modelKeyErrorResponse(new NoProviderKeyError(chosenModel.provider), "");
  }

  const requestedBranch = typeof body.branch === "string" ? body.branch.trim() : "";
  if (requestedBranch && !isValidBranchName(requestedBranch)) {
    return NextResponse.json(
      { error: "Use a valid Git branch name (letters, numbers, ., _, /, and -)." },
      { status: 400 },
    );
  }

  const keys = ownSandboxKeys(owner.id);
  let sandboxSettings: SandboxSettings;
  let provider: RuntimeProvider;
  try {
    // Outrunner's sandboxes, or the user's own Daytona or Modal (Settings → Sandbox).
    sandboxSettings = await getSandboxSettings(owner.id);
    provider = providerForNewSessions(sandboxSettings, keys);
  } catch (error) {
    if (error instanceof NoDaytonaKeyError || error instanceof NoModalTokenError) return needsSandbox(error.message);
    console.error("Runtime provider is unavailable", error);
    return NextResponse.json(
      { error: "The configured provider is not available." },
      { status: 503 },
    );
  }
  // Only a Runtime Computer's agent can put a session on another model, or
  // run Codex.
  if (agentId === "codex" && !isComputerProvider(provider)) {
    return NextResponse.json(
      { error: "Codex runs on Outrunner's cloud computers. Choose one under Settings → Sandbox.", settingsHref: "/settings/sandbox" },
      { status: 409 },
    );
  }
  // Only a Runtime Computer switches models: on any other sandbox, a session
  // runs on the user's Claude or not at all, whatever the menu offers.
  if (agentId === "claude" && !hasClaude && !isComputerProvider(provider)) {
    return needsClaude(
      "Sessions on this sandbox run only on your Claude account. Connect Claude in Settings, or choose another sandbox under Settings → Sandbox.",
    );
  }

  // A box is about to start, the new session's own: the plan's hours and box
  // count get their say before anything is created.
  const gate = await cloudBoxStartGate(owner, provider.name, null);
  if ("denial" in gate) return NextResponse.json(gate.denial, { status: 403 });

  let workspace;
  try {
    workspace = await createWorkspaceRow({
      ownerId: owner.id,
      projectId: project.id,
      branch: requestedBranch || generatedBranch(),
      baseBranch: project.defaultBranch,
      provider: provider.name,
      agent: agentId,
    });
  } catch (error) {
    // A requested branch can be one a live session already works on: name that
    // session and offer its page, rather than only saying one is there.
    // (Generated branches can't collide.) If that lookup itself fails, the
    // row's own failure is still the answer to give, not a thrown one.
    if (requestedBranch && isUniqueViolation(error)) {
      const holder = await liveWorkspaceOnBranch(owner.id, project.id, requestedBranch).catch((lookupError) => {
        console.error("Couldn't look up the session on that branch", lookupError);
        return null;
      });
      if (holder) return branchTakenResponse({ id: holder.id, label: workspaceLabel(holder) });
    }
    return workspaceCreateErrorResponse(error, "Couldn't create the session's row");
  }

  // The session opens now, on its setup progress, and its box is set up after
  // this response. A request held open for the whole setup tied the session to
  // the page that asked: leaving it lost the session's prompt and redirect, and
  // every other navigation waited on it.
  after(() =>
    provisionWorkspace({
      workspace,
      project,
      owner,
      provider,
      keys,
      sandboxSettings,
      githubToken,
      sessionEnv,
      hasClaude,
      menu,
      chosenModel,
      maxLiveComputers: gate.cap,
      chosenEffort,
      agentId,
      auth,
    }),
  );
  return NextResponse.json({ workspace: { id: workspace.id } }, { status: 202 });
}

/**
 * Set up a new session's box and start Claude in it, then mark the session
 * ready, or failed with why. It runs after the create request has answered, so
 * it never throws: the session's row is all that hears how it went. Each
 * outcome lands only on a session still setting up, so one deleted meanwhile
 * (a stalled setup may be) stays deleted.
 */
async function provisionWorkspace({
  workspace,
  project,
  owner,
  provider,
  keys,
  sandboxSettings,
  githubToken,
  sessionEnv,
  hasClaude,
  menu,
  chosenModel,
  maxLiveComputers,
  chosenEffort,
  agentId,
  auth,
}: {
  workspace: Workspace;
  project: Project;
  owner: Owner;
  provider: RuntimeProvider;
  keys: ReturnType<typeof ownSandboxKeys>;
  sandboxSettings: SandboxSettings;
  githubToken: string | undefined;
  sessionEnv: Record<string, string>;
  hasClaude: boolean;
  menu: Awaited<ReturnType<typeof modelMenu>>;
  /** Checked by the request: an offered model, or none for the default. */
  chosenModel: SessionModel | undefined;
  /** The plan's box cap, enforced by the claim in the database; null when none applies. */
  maxLiveComputers: number | null;
  /** Picked with it, or none for the model's own. */
  chosenEffort: Effort | undefined;
  /** The agent the session runs, and what it signs in with. */
  agentId: AgentId;
  auth: ResolvedAuth;
}): Promise<void> {
  const settle = async (patch: Parameters<typeof transitionWorkspace>[0]["patch"]) => {
    const moved = await transitionWorkspace({ id: workspace.id, from: SETTING_UP, patch });
    if (!moved) console.warn(`Workspace ${workspace.id} left setup before it finished (${patch.status})`);
    return moved !== null;
  };
  // Phases only: even the last stays "provisioning", so the ready below, with
  // the box's details, still finds the session setting up.
  // The step a failure stopped at, for the session page.
  let phase: ProvisionPhase | null = null;
  const setPhase = async (next: ProvisionPhase) => {
    phase = next;
    await settle({ status: "provisioning", phase: next });
  };
  // Cut from any error the session page shows.
  const secrets: (string | undefined)[] = [githubToken, auth.credential?.token, ...Object.values(sessionEnv)];

  try {
    if (isComputerProvider(provider)) {
      // The session's own box (lib/runtime/computer-scope.ts). New, it has
      // none yet; a setup started again may find the one it began, ready or
      // gone. Only transition the exact ready row we checked so parallel
      // requests retain the claim RPC's single-provisioner invariant.
      const scope = { workspaceId: workspace.id };
      const currentComputer = await getRuntimeComputer(scope);
      // The box that ended, for a provider that brings it back on the disk it
      // left (Modal), so the project's sessions carry on in the new one.
      let endedBox = endedBoxOf(currentComputer, provider.name);
      const needsNewComputer =
        !currentComputer?.daytonaSandboxId ||
        currentComputer.status !== "ready";

      // Show "allocate" phase only when provisioning a new computer
      if (needsNewComputer) {
        await setPhase("allocate");
      }

      if (currentComputer?.status === "ready" && currentComputer.daytonaSandboxId) {
        const sandboxId = currentComputer.daytonaSandboxId;
        const madeBy = computerMadeBy(currentComputer);
        if (madeBy !== provider.name) {
          // The owner moved to another sandbox (Settings → Sandbox). The old
          // box goes, so no one keeps paying for one nothing uses, and the
          // project gets a new computer where they chose.
          await retireComputer(madeBy, keys, sandboxId);
          await markRuntimeComputerStoppedIfReady(currentComputer.id, sandboxId);
        } else if (!(await provider.computerAlive(sandboxId))) {
          await markRuntimeComputerStoppedIfReady(currentComputer.id, sandboxId);
          endedBox = sandboxId;
        }
      }

      const ensured = await ensureComputer(provider, {
        scope,
        repoFullName: project.fullName,
        githubToken,
        sessionEnv,
        size: boxSizeOn(sandboxSettings.sandbox, sandboxSettings.boxSize, await planFor(owner.id)),
        maxLiveComputers,
        ...(provider.restoresBoxes && endedBox && { previousSandboxId: endedBox }),
      });
      const computer = ensured.computer;
      secrets.push(ensured.agentSecret);
      if (!computer.daytonaSandboxId) {
        throw new Error("Ready Runtime Computer has no sandbox id.");
      }

      // Provisioning clones the mirror. A box set up before (a setup started
      // again) has it refreshed before the agent branches from the project's
      // default branch.
      if (!ensured.provisioned) {
        await setPhase("clone");
        await provider.fetchMirror(computer.daytonaSandboxId, githubToken);
      }

      await setPhase("worktree");
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
      const upgrade = boxUpgrade(provider, computer.daytonaSandboxId, ensured.agentSecret, owner.id);
      const signIn = sessionAuthClient(agent, identity, upgrade);
      // Before the session is made: an agent too old for Codex would make a
      // Claude Code session of it. One that is, is upgraded in place.
      await readyBox(signIn, agentId, auth);
      const created = await agent.createWorkspace(
        {
          workspaceId: workspace.id,
          repoFullName: project.fullName,
          baseBranch: project.defaultBranch,
          branch: workspace.branch,
          // Named only for Codex: Claude Code is every agent's default.
          ...(agentId !== "claude" && { agent: agentId }),
          // Configure git author so commits are attributed to the user.
          ...(owner.email && { gitUser: { name: owner.name, email: owner.email } }),
        },
        identity,
      );
      // Before the first launch, so the agent starts signed in.
      await setPhase("secrets");
      await deliverSessionAuth(signIn, agentId, auth);
      // And with the user's own setup and its project's environment.
      await setUpSession(agent, identity, upgrade, owner.id, project.id);
      // Before the first launch, so Claude starts on it rather than switching.
      const startsOn = await startingModel({
        setModel: (req) => agent.setModel(identity, req),
        keyFor: (holder) => modelKey(owner.id, holder),
        hasClaude,
        model: chosenModel,
        effort: chosenEffort,
        fallback: defaultModel(menu),
      });
      // So its next relaunch goes back on it, its key fetched again.
      await recordWorkspaceModel(workspace.id, startsOn);
      await setPhase("health_check");
      await agent.startWorkspace(identity);

      const ready = await settle({
        status: "ready",
        phase: "claude_ready",
        computerId: computer.id,
        tmuxSession: `ws-${workspace.id}`,
        agentWorkspaceId: workspace.id,
        worktreePath: created.worktree,
        errorMessage: null,
        touchActive: true,
      });
      // Deleted while it set up: take down the worktree and Claude it no
      // longer has, as its delete would have.
      if (!ready) {
        await agent.destroyWorkspace(identity).catch((error: unknown) =>
          console.warn(`Workspace ${workspace.id} teardown after delete failed`, error),
        );
      }
      return;
    }

    const result = await provider.createWorkspace({
      workspaceId: workspace.id,
      repoFullName: project.fullName,
      baseBranch: project.defaultBranch,
      branch: workspace.branch,
      env: workspaceCloneEnvironment(githubToken),
      onPhase: setPhase,
    });

    await settle({
      status: "ready",
      phase: "claude_ready",
      sandboxId: result.sandboxId,
      volumeName: result.volumeName,
      worktreePath: result.worktreePath,
      errorMessage: result.warnings.length
        ? "Dependency installation completed with warnings."
        : null,
      touchActive: true,
    });
  } catch (error) {
    console.error(`Workspace ${workspace.id} provisioning failed`, error);
    // The session page shows this: say what to do where the user can fix it,
    // or else the step it stopped at and why, so the cause isn't only in the
    // log. A Claude model's effort is set on the way to the user's own Claude,
    // which startingModel leaves unwrapped: its message says to update the box.
    // The plan's cap can refuse a start mid-flight (a simultaneous start won
    // the slot first): say so, rather than blame the setup.
    const refused = isPlanLimitError(error);
    const errorMessage =
      error instanceof NoStartingModelError ||
      error instanceof OutdatedComputerError ||
      error instanceof EffortUnsupportedError
        ? error.message
        : refused
          ? refused.message
          : provisionFailureMessage(error, phase, secrets);
    await settle({ status: "failed", errorMessage }).catch((updateError: unknown) =>
      console.error(`Workspace ${workspace.id} failure state could not be saved`, updateError),
    );
  }
}
