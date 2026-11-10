import { NoGcpConnectionError } from "@/lib/runtime/user-gcp-provider";
/**
 * Making a cloud session and setting up its box: what the new-session screen
 * asks for (app/api/projects/[id]/workspaces/route.ts), and what the server
 * starts on a user's behalf (lib/session/server-session.ts).
 */

import { getModelLoadout } from "@/lib/db/model-loadout";
import { withOrgDefault } from "@/lib/orgs/defaults";
import { agentConnection } from "@/lib/agents/resolve";
import { codexModelsFor } from "@/lib/codex/model-catalog.deps";
import { creationSelection } from "@/lib/runtime/selection";
import { optionalEnv } from "@/lib/env";
import { PLAN_MODE_PREAMBLE } from "@/lib/api/create-request";
import { generatedBranch, insertOnBranch } from "@/lib/session/generated-branch";

import { after, NextResponse } from "next/server";

import type { AgentId } from "@/lib/agents/registry";
import { AgentAuthError, resolveAgentAuth, type ResolvedAuth } from "@/lib/agents/resolve";
import type { Owner } from "@/lib/auth/owner";
import { sessionPlan } from "@/lib/billing/entitlements";
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
import { isMetered } from "@/lib/billing/metering-store";
import { releaseWorkspaceBox } from "@/lib/billing/release-box.deps";
import {
  createWorkspaceRow,
  getProject,
  getRuntimeComputer,
  getWorkspace,
  liveWorkspaceOnBranch,
  projectBranchesLike,
  markRuntimeComputerStoppedIfReady,
  recordWorkspaceModel,
  setWorkspaceTitleIfUnset,
  transitionWorkspace,
} from "@/lib/db/repositories";
import { defaultEnvironmentId, sessionCheckouts, setupGeneration } from "@/lib/db/environments";
import { linkWorkItemToSession, projectOrgId, triageActor } from "@/lib/db/work-items";
import { isUuid } from "@/lib/ids";
import { modelKeyErrorResponse } from "@/lib/http/model-key-errors";
import {
  branchTakenByTeammateResponse,
  branchTakenResponse,
  idTakenResponse,
  isIdTaken,
  isUniqueViolation,
  workspaceCreateErrorResponse,
} from "@/lib/http/workspace-create-errors";
import { inTeamOrg } from "@/lib/db/orgs";
import { orgDefaultsFor } from "@/lib/db/org-defaults";
import { workspaceLabel } from "@/lib/nav/session-title";
import { NoProviderKeyError } from "@/lib/providers/errors";
import { isProviderId } from "@/lib/providers/registry";
import { newBoxSize } from "@/lib/orgs/defaults";
import { appUrl } from "@/lib/orgs/notify";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_CODEX_GATEWAY, AGENT_FEATURE_MULTI_REPO } from "@/lib/runtime/agent-protocol";
import { materializeAttachments } from "@/lib/runtime/materialize-attachments";
import { requireFeature } from "@/lib/runtime/box-features";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { NoDaytonaKeyError } from "@/lib/runtime/daytona-provider";
import { isValidBranchName } from "@/lib/runtime/git";
import { provisionFailureMessage } from "@/lib/runtime/provision-failure";
import { setUpSession } from "@/lib/runtime/session-setup.deps";
import { NO_OUTRUNNER_MODELS, NoStartingModelError, startingModel } from "@/lib/runtime/model-switch";
import {
  compatibleEffort,
  modelGroups,
  agentsFor,
  defaultModel,
  type Effort,
  EffortUnsupportedError,
  onCodexGateway,
  requestedAgent,
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
import { boxUpgrade, runtimeSessionEnvironment, withoutGitHubToken } from "@/lib/runtime/session-environment";
import { ensureComputer } from "@/lib/runtime/runtime-computer-service";
import { projectCheckouts } from "@/lib/runtime/warm-pool";
import { refillProjectPool, takePooledBox } from "@/lib/runtime/warm-pool.deps";
import type { BoxSizeId } from "@/lib/runtime/box-sizes";
import type { Project, ProvisionPhase, RuntimeProvider, Workspace, WorkspaceSource } from "@/lib/runtime/types";
import { nameSessionFromPrompt } from "@/lib/session/name-session";
import { evidenceToolsFor, prGuide } from "@/lib/session/pr-template";
import { SETTING_UP } from "@/lib/session/provisioning";
import { branchKnownOnGitHub, getGitHubRepository, GitHubReconnectError, MissingGithubTokenError } from "@/lib/github/client";
import { GITHUB_RECONNECT_HREF } from "@/lib/github/http";
import { GitIdentityError } from "@/lib/github/identity";
import { gitTokensFor, markReviewSession, REVIEW_AS_APP, requireGitToken } from "@/lib/github/identity.deps";
import { githubCoAuthor } from "@/lib/github/co-author";
import { workspaceCloneEnvironment } from "@/lib/runtime/workspace-environment";
import { PROVIDERS_SETTINGS_HREF, providerSettingsHref } from "@/lib/settings-links";

/** The session `id`, when an earlier send of the same create made it: the
 *  user's own, in this repository. Null for none, or one that isn't that. */
async function madeBefore(id: string, ownerId: string, projectId: string): Promise<Workspace | null> {
  const made = await getWorkspace(id).catch(() => null);
  return made && made.ownerId === ownerId && made.projectId === projectId ? made : null;
}

/** The session can't run without the user's Claude: say so, and where to fix it. */
function needsClaude(error: string) {
  return NextResponse.json({ error, settingsHref: providerSettingsHref("claude") }, { status: 409 });
}

function needsSandbox(error: string) {
  return NextResponse.json({ error: `${error} Ask your deployment administrator to check runtime configuration.` }, { status: 409 });
}

/** What the new-session screen asks for, as it sends it (each checked below). */
export type SessionRequest = {
  branch?: unknown;
  provider?: unknown;
  model?: unknown;
  key?: unknown;
  effort?: unknown;
  /** The agent the session is asked to run (requestedAgent). */
  agent?: unknown;
  /** The first prompt, only to name the session by. */
  prompt?: unknown;
  /** The triage item the session was started from (Start session). */
  workItemId?: unknown;
  /** The id the screen made for it (a UUID), so its page opens at once, on
   *  the session as the screen holds it, while this request is answered
   *  (hooks/use-create-session.ts). The database's own when not given. */
  id?: unknown;
};

/** How it ended: ready (and its first message sent, if it had one), or failed. */
export type SessionOutcome = { workspaceId: string; status: "ready" | "failed"; errorMessage?: string };

/** What only the server asks for: a session it starts on its own, on the
 *  user's behalf (an automation's), rather than the new-session screen. */
export type ServerSessionOptions = {
  /** The branch it starts from; the project's default branch when not given. */
  baseBranch?: string;
  /** Its title, instead of one made from `prompt`. */
  title?: string;
  /** Sent to the agent once it's ready, as the user's first message would be. */
  firstMessage?: string;
  /** Files uploaded for the first message (POST /api/attachments), put on
   *  the box and named in it as the composer's are. */
  firstAttachmentIds?: string[];
  /** Set it up before answering, not after: for a caller with no page waiting. */
  inline?: boolean;
  /** Only on Outrunner's models metered to the user (their allowance): a
   *  server whose models run on one shared key meters no one, and what the
   *  server starts on its own mustn't spend it unwatched. */
  meteredOnly?: boolean;
  /**
   * An automation's review: it works on GitHub as the Outrunner App, reading
   * code and commenting on pull requests (REVIEW_AS_APP), whatever its user
   * chose for their own sessions. Its box is its own, never a pooled one
   * booted with the user's GitHub token, and holds none of theirs: it asks
   * for the App's as it goes (app/api/runtime/git-credential).
   */
  reviewAsApp?: boolean;
  /** Told the session's id as soon as its row is made, before its setup; if
   *  it throws, the session fails there and goes no further. */
  onCreated?: (workspaceId: string) => Promise<void>;
  /** Told how its setup ended. */
  onSettled?: (outcome: SessionOutcome) => Promise<void>;
  /** Where it was started, for the API's `source` filter; the app when not
   *  given. */
  source?: WorkspaceSource;
  /** The size of its box, asked by the API, instead of the one the user (or
   *  their org) chose. Never beyond what their plan allows (boxSizeOn). */
  boxSize?: BoxSizeId;
  /** A Mission, or a Runner of `parentMissionId` (docs/missions.md). */
  kind?: "mission";
  parentMissionId?: string;
  /** The project (an `environments` row) it starts from, one the user may
   *  read; the repository's default project when not given. */
  environmentId?: string;
};

/**
 * Create a cloud session of `projectId` for `owner`, and set up its box: the
 * new-session screen's (POST /api/projects/[id]/workspaces), and the server's
 * own, inside actAsUser (lib/supabase/acting-user.ts), which reads and writes
 * as the user just as their browser would. Answers as the route does: 202 with
 * the session's id once its row is made, or why it can't be.
 *
 * A send of the same create again (the screen's own id, its answer lost) can
 * overlap the first: it passes the check for a session already made while
 * the first is still in GitHub's checks, and then the first's row — and its
 * box, against the plan's limit — makes this one refused. So any refusal of
 * a create carrying its id, made before its own insert, asks once more
 * whether that session was made, and answers with it if so. A refusal after
 * its own insert (a caller told of it that failed) is its own answer: that row
 * is this call's, and it says why it didn't start.
 */
export async function createCloudSession(
  owner: Owner,
  projectId: string,
  body: SessionRequest,
  options: ServerSessionOptions = {},
): Promise<Response> {
  const progress = { inserted: false };
  const answer = await createOnce(owner, projectId, body, options, progress);
  const askedId = typeof body.id === "string" && isUuid(body.id) ? body.id : undefined;
  if (!askedId || answer.status < 400 || progress.inserted) return answer;
  const made = await madeBefore(askedId, owner.id, projectId);
  return made ? NextResponse.json({ workspace: made }, { status: 202 }) : answer;
}

async function createOnce(
  owner: Owner,
  projectId: string,
  body: SessionRequest,
  options: ServerSessionOptions,
  /** Set once this call has made the session's row. */
  progress: { inserted: boolean },
): Promise<Response> {
  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  // The id the new-session screen made, when it sent a well-formed one. A
  // send whose answer was lost is sent again with it (hooks/use-create-session.ts):
  // when an earlier send made the session, it is the answer, ahead of every
  // check below — the box gate among them, which that session now counts
  // against.
  const askedId = typeof body.id === "string" && isUuid(body.id) ? body.id : undefined;
  if (askedId) {
    const made = await madeBefore(askedId, owner.id, project.id);
    if (made) return NextResponse.json({ workspace: made }, { status: 202 });
  }
  // The model chosen on the new-session screen; none, the menu's default.
  let chosenModel = requestedModel(body);
  if (chosenModel === null) {
    return NextResponse.json({ error: "Choose one of the offered models." }, { status: 400 });
  }
  // Picked with it; none, the model's own.
  let chosenEffort = requestedEffort(body);
  if (chosenEffort === null) {
    return NextResponse.json({ error: "Choose one of the offered efforts." }, { status: 400 });
  }
  // The agent asked for (onboarding's "Codex on Outrunner's models"), which
  // must run the model chosen with it; none, the model's own: Codex for
  // Codex's models, Claude Code for every other, and for none.
  const askedAgent = requestedAgent(body);
  if (askedAgent === null || (askedAgent && chosenModel && !agentsFor(chosenModel.provider).includes(askedAgent))) {
    return NextResponse.json({ error: "Choose a model the agent runs." }, { status: 400 });
  }
  // The same personal > organization > eligible runtime precedence as the
  // composer, also for API callers that omit a model. Do not write preferences.
  const store = agentAuthStore(owner.id, project.orgId);
  const [baseMenu, mine, orgDefaults, claude, codex, catalog] = await Promise.all([
    modelMenu(owner.id, project.orgId), getModelLoadout(owner.id), orgDefaultsFor(project.orgId),
    agentConnection(store, "claude"), agentConnection(store, "codex"),
    chosenModel && chosenModel.provider !== "codex" ? Promise.resolve([]) : codexModelsFor(store),
  ]);
  const menu = { ...baseMenu, codexModels: catalog };
  const accounts: AgentId[] = [...(claude.cloud ? ["claude" as const] : []), ...(codex.cloud ? ["codex" as const] : [])];
  const groups = modelGroups(menu, accounts);
  const keys = ownSandboxKeys(owner.id);
  let sandboxSettings: SandboxSettings;
  let provider: RuntimeProvider;
  try {
    // Outrunner's sandboxes, or the user's own Daytona or Modal (Settings → Sandbox).
    sandboxSettings = await getSandboxSettings(owner.id);
    provider = providerForNewSessions(sandboxSettings, keys);
  } catch (error) {
    if (error instanceof NoDaytonaKeyError || error instanceof NoModalTokenError || error instanceof NoGcpConnectionError) return needsSandbox(error.message);
    console.error("Runtime provider is unavailable", error);
    return NextResponse.json(
      { error: "The configured provider is not available." },
      { status: 503 },
    );
  }
  const supported: AgentId[] = isComputerProvider(provider) && optionalEnv("RUNTIME_ENGINE") !== "jcode" ? ["claude", "codex"] : ["claude"];
  let agentId: AgentId;
  try {
    const selection = creationSelection(groups, withOrgDefault(mine, orgDefaults.defaultModel), {
      model: chosenModel, agent: askedAgent, effort: chosenEffort,
      defaultEffort: body.effort === undefined, supported,
    });
    chosenModel = selection.model;
    chosenEffort = selection.effort ?? undefined;
    agentId = selection.agent;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Choose an eligible harness and model." }, { status: 409 });
  }
  // First: it turns on the server's setup alone, and no credential of the
  // user's would change it.
  if (options.meteredOnly && !menu.allowance) {
    return NextResponse.json(
      { error: "Outrunner's models aren't metered per user on this server, so it can't start sessions on its own." },
      { status: 409 },
    );
  }
  // What it needs to start: the model chosen, else the menu's default. On a
  // model on a key, Claude Code needs no account of the user's: one they
  // haven't connected doesn't stop it, and one they have is still resolved,
  // so a session with none chosen starts on it (startingModel).
  const startsOn = chosenModel ?? defaultModel(menu);
  const ownAccount = !startsOn || runsOnOwnAccount(startsOn);
  // How it signs in, said before a box is set up for it, not after.
  let auth: ResolvedAuth;
  try {
    auth = await resolveAgentAuth(agentAuthStore(owner.id, project.orgId), agentId, "cloud", { ownAccount });
  } catch (error) {
    if (!(error instanceof AgentAuthError)) throw error;
    return NextResponse.json({ error: error.message, settingsHref: error.settingsHref }, { status: 409 });
  }

  // Who the session's git acts as on GitHub (lib/github/identity.ts): the
  // repository's token now, for the box's mirror; the box asks for its own.
  const as = options.reviewAsApp ? REVIEW_AS_APP : undefined;
  const tokenFor = gitTokenFor(owner.id, project.orgId, as);
  const githubToken = await tokenFor(project.fullName);
  if ("refusal" in githubToken) return githubToken.refusal;
  // Before the session exists (its pooled box was booted for none): a
  // review's box asks for the App's tokens, and the user's own isn't on it.
  const userEnv = await runtimeSessionEnvironment(owner.id, null);
  const sessionEnv = options.reviewAsApp ? withoutGitHubToken(userEnv) : userEnv;
  // Whether it can run on the user's Claude: only as they picked it (or, with
  // no pick, on what they saved), which `auth` holds. Never on the box's own
  // environment instead, which may hold a key the user didn't pick, or one
  // since removed: a session falling back on it would be billed to the wrong
  // account. With none chosen, a session starts on it where it is connected,
  // else on Outrunner's models (on the user's own OpenRouter key, or the
  // server's), so only without those is Claude a must. Codex runs on its own
  // sign-in, resolved above.
  const hasClaude = agentId === "claude" && auth.credential !== null;
  if (agentId === "claude" && !hasClaude && !offersModels(menu)) {
    return NextResponse.json({ error: NO_OUTRUNNER_MODELS, settingsHref: PROVIDERS_SETTINGS_HREF }, { status: 409 });
  }
  if (project.private && !githubToken.token) {
    return NextResponse.json(
      {
        error:
          "Connect your GitHub account in Settings → Account to clone a private repository.",
      },
      { status: 409 },
    );
  }

  // Said before a box is set up for it, not after.
  if (chosenModel?.provider === "outrunner" && !menu.outrunner) {
    return NextResponse.json({ error: "Outrunner's models aren't available on this server." }, { status: 409 });
  }
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

  // Only a Runtime Computer's agent can put a session on another model, or
  // run Codex.
  if (agentId === "codex" && !isComputerProvider(provider)) {
    return NextResponse.json(
      { error: "Codex requires a cloud computer. Ask your deployment administrator to check runtime configuration." },
      { status: 409 },
    );
  }
  // A first message is delivered to a Runtime Computer's agent; no other
  // sandbox takes one from the server.
  if (options.firstMessage && !isComputerProvider(provider)) {
    return needsSandbox("Sessions the server starts (automations, the API) require a cloud computer.");
  }
  // Only a Runtime Computer switches models: on any other sandbox, a session
  // runs on the user's Claude or not at all, whatever the menu offers.
  if (agentId === "claude" && !hasClaude && !isComputerProvider(provider)) {
    return needsClaude(
      "Sessions on this runtime require your Claude account. Connect it under Personal → Coding agents.",
    );
  }

  // Last of the checks, after the cheap local ones: it asks GitHub.
  const github = await githubRefusal(githubToken.token, project);
  if (github) return github;

  // A box is about to start, the new session's own: the plan's hours and box
  // count get their say before anything is created.
  // An intent-warmed pooled box already consumes this session's slot. Let
  // this create inherit it even when that makes the plan look full.
  const gate = await cloudBoxStartGate(owner, project.orgId, provider.name, {
    warmProjectId: project.id,
  });
  if ("denial" in gate) return NextResponse.json(gate.denial, { status: 403 });

  // The project the session starts from: the repository's own, made on its
  // first session. A failure here doesn't stop the session: with none
  // recorded, its setup looks the project up again (setUpSession).
  const environmentId = options.environmentId ?? await defaultEnvironmentId(owner.id, project.id).catch((error: unknown) => {
    console.error(`Project for ${project.fullName} couldn't be found or made`, error);
    return null;
  });
  // A project of several repositories: the session works on each, in its own
  // folder. Only on a Runtime Computer, whose agent makes the folder.
  const baseBranch = options.baseBranch ?? project.defaultBranch;
  if (!isValidBranchName(baseBranch)) {
    return NextResponse.json({ error: "The session's base branch isn't a valid Git branch name." }, { status: 400 });
  }
  // Every repository the session's branch is made in, for a generated one to
  // be free in each.
  const branchRepos = [{ fullName: project.fullName, token: githubToken.token }];
  const checkouts = environmentId ? projectCheckouts(await sessionCheckouts(owner.id, environmentId), project.id, baseBranch) : null;
  if (checkouts) {
    if (!isComputerProvider(provider)) {
      return NextResponse.json(
        { error: "Projects with several repositories require a cloud computer. Ask your deployment administrator to check runtime configuration." },
        { status: 409 },
      );
    }
    for (const other of checkouts.filter((c) => c.projectId !== project.id)) {
      // As for the session's own repository: a public one GitHub doesn't show
      // this token still clones, so only a private one is refused.
      const otherToken = await tokenFor(other.fullName);
      if ("refusal" in otherToken) return otherToken.refusal;
      branchRepos.push({ fullName: other.fullName, token: otherToken.token });
      const refused = await githubRefusal(otherToken.token, { fullName: other.fullName, private: other.private ?? true });
      if (refused) return refused;
    }
  }

  // What a generated branch is named from: the title the caller gave, else
  // the first prompt, the server's own or the one the screen sent to name it.
  const about = {
    title: options.title,
    prompt: (options.firstMessage ?? (typeof body.prompt === "string" ? body.prompt : "")).replace(PLAN_MODE_PREAMBLE, ""),
  };
  let workspace;
  try {
    const generation = {
      sessionBranches: (base: string) => projectBranchesLike(project.id, base),
      // Every repository at once. Without a token, GitHub isn't asked:
      // nothing gets pushed there either.
      knownOnGitHub: async (branch: string) =>
        (
          await Promise.all(
            branchRepos.map((repo) =>
              repo.token ? branchKnownOnGitHub({ token: repo.token, repoFullName: repo.fullName, branch }) : false,
            ),
          )
        ).some(Boolean),
    };
    workspace = await insertOnBranch({
      requested: requestedBranch,
      generate: (lost) => generatedBranch(about, generation, lost),
      insert: (branch) =>
        createWorkspaceRow({
          ...(askedId && { id: askedId }),
          ownerId: owner.id,
          projectId: project.id,
          environmentId,
          checkouts,
          branch,
          // Made up here, for the agent to give it its real name once it
          // knows the change: not a review's (it pushes nothing of its own),
          // nor a GitHub follow-up's (it pushes to its pull request's head).
          branchRenamable: !requestedBranch && !options.reviewAsApp && options.source !== "github",
          baseBranch,
          provider: provider.name,
          agent: agentId,
          source: options.source,
          kind: options.kind,
          parentMissionId: options.parentMissionId,
        }),
      isBranchTaken: (error) => isUniqueViolation(error) && !isIdTaken(error),
    });
    progress.inserted = true;
    if (chosenModel) {
      const intended = { model: chosenModel, effort: compatibleEffort(chosenModel, chosenEffort) };
      await recordWorkspaceModel(workspace.id, intended);
      workspace = { ...workspace, model: intended };
    }
  } catch (error) {
    // The id is taken, not the branch: the same create sent again after its
    // answer was lost. The user's own session of this repository is the one
    // the first send made, so it is the answer again (its setup is already
    // under way); any other is a plain conflict, never a branch's.
    if (askedId && isIdTaken(error)) {
      const made = await madeBefore(askedId, owner.id, project.id);
      return made ? NextResponse.json({ workspace: made }, { status: 202 }) : idTakenResponse();
    }
    // A requested branch can be one a live session already works on: name that
    // session and offer its page, rather than only saying one is there.
    // (A generated one that collides is named again, above.) Not the user's own, in a team org's
    // project: another member has it, whose session they can't open. Anywhere
    // else (a session ended between the insert and the lookup), the plain
    // answer. If a lookup itself fails, the row's own failure is still the
    // answer to give, not a thrown one.
    if (requestedBranch && isUniqueViolation(error)) {
      const holder = await liveWorkspaceOnBranch(owner.id, project.id, requestedBranch).catch((lookupError) => {
        console.error("Couldn't look up the session on that branch", lookupError);
        return undefined;
      });
      if (holder) return branchTakenResponse({ id: holder.id, label: workspaceLabel(holder) });
      if (holder === null && (await inTeamOrg(project.id).catch(() => false))) return branchTakenByTeammateResponse();
    }
    return workspaceCreateErrorResponse(error, "Couldn't create the session's row");
  }
  // Named now, from its first prompt, as the message route would once that is
  // delivered: until then the sidebar showed its branch. That later naming
  // then leaves it be (a title is never replaced).
  // A review is recorded as one (by the server: review_sessions), and its
  // caller told of it, before its box exists to ask for a token; one that
  // can't be goes no further than its row, failed, rather than run as its user.
  if (options.reviewAsApp || options.onCreated) {
    try {
      if (options.reviewAsApp) await markReviewSession(workspace.id);
      await options.onCreated?.(workspace.id);
    } catch (error) {
      console.error(`Workspace ${workspace.id}: its caller couldn't hear it was made`, error);
      const errorMessage = "Outrunner couldn't record what this session is for, so it didn't start.";
      await transitionWorkspace({ id: workspace.id, from: SETTING_UP, patch: { status: "failed", errorMessage } }).catch(
        (updateError: unknown) => console.error(`Workspace ${workspace.id} failure state could not be saved`, updateError),
      );
      return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
  }
  if (options.title) {
    await setWorkspaceTitleIfUnset(workspace.id, options.title).catch((error: unknown) =>
      console.error(`Could not title session ${workspace.id}`, error),
    );
  } else {
    await nameSessionFromPrompt(workspace, typeof body.prompt === "string" ? body.prompt : "");
  }
  // Started from a triage item: the item is in progress, on this session. The
  // session starts either way; the item is only bookkeeping.
  if (typeof body.workItemId === "string" && body.workItemId) {
    const workItemId = body.workItemId;
    // As a triager in the project's org: an item of another org is no item.
    await projectOrgId(project.id)
      .then((orgId) => (orgId ? triageActor(owner.id, orgId) : null))
      .then((actor) =>
        actor ? linkWorkItemToSession(actor, workItemId, { workspaceId: workspace.id, projectId: project.id }) : undefined,
      )
      .catch((error: unknown) => console.error("Couldn't link the triage item to its session", error));
  }

  // The session opens now, on its setup progress, and its box is set up after
  // this response. A request held open for the whole setup tied the session to
  // the page that asked: leaving it lost the session's prompt and redirect, and
  // every other navigation waited on it.
  const provision = () =>
    provisionWorkspace({
      workspace,
      project,
      owner,
      provider,
      keys,
      sandboxSettings,
      githubToken: githubToken.token,
      sessionEnv,
      hasClaude,
      menu,
      chosenModel,
      maxLiveComputers: gate.cap,
      chosenEffort,
      agentId,
      auth,
      firstMessage: options.firstMessage,
      firstAttachmentIds: options.firstAttachmentIds,
      onSettled: options.onSettled,
      inline: options.inline ?? false,
      as,
      boxSize: options.boxSize,
    });
  if (options.inline) await provision();
  else after(provision);
  // The whole row, not only its id: the caller opens the session on it at once
  // (lib/session/pending-sessions.ts), rather than waiting for the layout's
  // data to be read again. Read back rather than sent as it was inserted,
  // because it has been titled since — a row without its title would show the
  // session as its branch until the server's own read caught up.
  const answered = (await getWorkspace(workspace.id).catch((error: unknown) => {
    console.error(`Workspace ${workspace.id}: could not read its row back`, error);
    return null;
  })) ?? workspace;
  return NextResponse.json({ workspace: answered }, { status: 202 });
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
  firstMessage,
  firstAttachmentIds,
  onSettled,
  inline,
  as,
  boxSize,
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
  firstMessage?: string;
  firstAttachmentIds?: string[];
  onSettled?: (outcome: SessionOutcome) => Promise<void>;
  /** Set up before the create answered (ServerSessionOptions.inline). */
  inline: boolean;
  /** An automation's review, as the App (ServerSessionOptions.reviewAsApp). */
  as?: typeof REVIEW_AS_APP;
  /** The box's size, where its caller asked for one (ServerSessionOptions.boxSize). */
  boxSize?: BoxSizeId;
}): Promise<void> {
  const tell = async (outcome: Omit<SessionOutcome, "workspaceId">) => {
    await onSettled?.({ workspaceId: workspace.id, ...outcome }).catch((error: unknown) =>
      console.error(`Workspace ${workspace.id}: its caller couldn't hear how setup went`, error),
    );
  };
  const settle = async (patch: Parameters<typeof transitionWorkspace>[0]["patch"]) => {
    const moved = await transitionWorkspace({ id: workspace.id, from: SETTING_UP, patch });
    if (!moved) console.warn(`Workspace ${workspace.id} left setup before it finished (${patch.status})`);
    return moved !== null;
  };
  // Phases only: even the last stays "provisioning", so the ready below, with
  // the box's details, still finds the session setting up.
  // The step a failure stopped at, for the session page.
  let phase: ProvisionPhase | null = null;
  // Each step in the log, timed: a setup that stops partway is found by the
  // last one it reached.
  const began = Date.now();
  const elapsed = () => `${Math.round((Date.now() - began) / 1000)}s into setup`;
  let phaseStarted = began;
  const logPhase = (next: string) => {
    const now = Date.now();
    console.info("Session startup", JSON.stringify({ workspaceId: workspace.id, stage: phase ?? "preparing", ms: now - phaseStarted, elapsedMs: now - began, next }));
    phaseStarted = now;
  };
  const setPhase = async (next: ProvisionPhase) => {
    logPhase(next);
    console.log(`Workspace ${workspace.id}: ${next} (${elapsed()})`);
    phase = next;
    await settle({ status: "provisioning", phase: next });
  };
  // A session deleted while it set up: its delete found no box to take (a
  // box's id is recorded only once it's up), so the one this setup made goes
  // now, as the delete would have taken it, rather than run on for good. Only
  // once it's deleted: one the sweep failed may be tried again on this box.
  const releaseIfDeleted = async () => {
    if (!isComputerProvider(provider)) return;
    const now = await getWorkspace(workspace.id).catch((error: unknown) => {
      console.error(`Workspace ${workspace.id}: couldn't tell whether it was deleted while it set up`, error);
      return undefined;
    });
    if (now === undefined || (now && now.status !== "destroying" && now.status !== "destroyed")) return;
    await releaseWorkspaceBox(provider, workspace, true);
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
      // The project's pooled box, made ready ahead (lib/runtime/warm-pool.ts),
      // becomes this session's, stopped: it starts again below on its disk,
      // as a box that ended does, in seconds.
      // Only one warmed from the project's setup as it is now.
      // Not for a review as the App: a pooled box was booted with its user's
      // GitHub token.
      if (!as) {
        const generation = await setupGeneration(owner.id, workspace.environmentId).catch(() => null);
        await takePooledBox(provider, workspace.id, generation);
      }
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
        // Theirs once they chose one, else their org's (lib/orgs/defaults.ts).
        size: boxSizeOn(
          sandboxSettings.sandbox,
          boxSize ?? newBoxSize(sandboxSettings, (await orgDefaultsFor(project.orgId)).boxSize),
          await sessionPlan(owner.id, project.orgId),
        ),
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
      const upgrade = boxUpgrade(provider, computer.daytonaSandboxId, ensured.agentSecret, owner.id, workspace.id);
      const signIn = sessionAuthClient(agent, identity, upgrade);
      // Before the session is made: an agent too old for Codex would make a
      // Claude Code session of it. One that is, is upgraded in place.
      await readyBox(signIn, agentId, auth);
      // And one too old to run Codex through a gateway would refuse its model.
      if (chosenModel && onCodexGateway(agentId, chosenModel)) {
        const features = { features: async () => (await agent.health(identity)).features ?? [], upgrade };
        await requireFeature(features, AGENT_FEATURE_CODEX_GATEWAY, "run Codex on Outrunner's models");
      }
      // A session of several repositories: a mirror of each on the box,
      // brought up to date, for its folder of checkouts.
      const checkouts = workspace.checkouts;
      if (checkouts) {
        const features = { features: async () => (await agent.health(identity)).features ?? [], upgrade };
        await requireFeature(features, AGENT_FEATURE_MULTI_REPO, "work on several repositories");
        await setPhase("clone");
        await provider.syncRepoMirrors(
          computer.daytonaSandboxId,
          checkouts.map((c) => ({ fullName: c.fullName, checkout: c.checkout })),
          gitTokensFor(owner.id, project.orgId, as),
        );
      }
      const created = await agent.createWorkspace(
        {
          workspaceId: workspace.id,
          repoFullName: checkouts?.[0].fullName ?? project.fullName,
          baseBranch: checkouts?.[0].baseBranch ?? workspace.baseBranch,
          branch: workspace.branch,
          ...(workspace.branchRenamable && { branchRenamable: true }),
          ...(checkouts && {
            repos: checkouts.map((c) => ({ fullName: c.fullName, checkout: c.checkout, baseBranch: c.baseBranch })),
          }),
          // Named only for Codex: Claude Code is every agent's default.
          ...(agentId !== "claude" && { agent: agentId }),
          // Configure git author so commits are attributed to the user.
          ...(owner.email && { gitUser: { name: owner.name, email: owner.email } }),
          // How it writes a pull request, however it's asked to open one.
          guide: prGuide({
            tools: evidenceToolsFor(provider.name),
            baseBranch: workspace.baseBranch,
            checkouts: checkouts ?? undefined,
            sessionUrl: appUrl(`/workspaces/${workspace.id}`, "https://app.outrunner.sh"),
            userName: owner.name,
            coAuthors: [githubCoAuthor(owner)].filter((author): author is string => author !== null),
          }),
        },
        identity,
      );
      // Before the first launch, so the agent starts signed in.
      await setPhase("secrets");
      await deliverSessionAuth(signIn, agentId, auth);
      // And with the user's own setup and its project's environment.
      await setUpSession(agent, identity, upgrade, owner.id, project.id, workspace.environmentId, {
        agent: agentId,
        appIdentity: as !== undefined,
      });
      // Before the first launch, so Claude starts on it rather than switching.
      const startsOn = await startingModel({
        setModel: (req) => agent.setModel(identity, req),
        keyFor: (holder) => modelKey(owner.id, holder, project.orgId),
        hasClaude,
        model: chosenModel,
        effort: chosenEffort,
        // None chosen: the user's Claude where it's connected (Opus, at
        // DEFAULT_EFFORT), as the new-session screen shows; else the menu's.
        fallback: defaultModel(menu),
      });
      // So its next relaunch goes back on it, its key fetched again.
      await recordWorkspaceModel(workspace.id, startsOn);
      await setPhase("health_check");
      await agent.startWorkspace(identity);
      logPhase("ready");
      console.log(`Workspace ${workspace.id}: ready (${elapsed()})`);

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
        await releaseIfDeleted();
        await tell({ status: "failed", errorMessage: "The session was deleted while it was set up." });
        return;
      }
      // The server's own first message (an automation's prompt), sent as the
      // user's would be from the session page.
      if (firstMessage) {
        try {
          const prompt = firstAttachmentIds?.length
            ? await materializeAttachments({
                provider,
                sandboxId: computer.daytonaSandboxId,
                worktreePath: created.worktree,
                workspaceId: workspace.id,
                attachmentIds: firstAttachmentIds,
                prompt: firstMessage,
              })
            : firstMessage;
          await agent.sendMessage(identity, prompt);
        } catch (error) {
          console.error(`Workspace ${workspace.id}: first message failed`, error);
          await tell({ status: "failed", errorMessage: "The session started, but its prompt couldn't be sent." });
          return;
        }
      }
      await tell({ status: "ready" });
      // Ready: the project's next session gets a box made ahead, after this
      // session's setup rather than as part of it.
      // Inline (the server's own session), there's no response to wait for:
      // it refills now, still signed in as the user. Its caller has heard the
      // outcome already (onSettled, above), so only the wait for it is longer;
      // left running after the sign-out, the refill's writes would be on a
      // session that has ended.
      // A review took no pooled box, so has none to make again.
      if (as) return;
      const refill = () =>
        refillProjectPool({ provider, ownerId: owner.id, project, environmentId: workspace.environmentId, githubToken, sessionEnv });
      if (inline) await refill();
      else after(refill);
      return;
    }

    const result = await provider.createWorkspace({
      workspaceId: workspace.id,
      repoFullName: project.fullName,
      baseBranch: workspace.baseBranch,
      branch: workspace.branch,
      env: workspaceCloneEnvironment(githubToken),
      onPhase: setPhase,
    });

    const ready = await settle({
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
    await tell(ready ? { status: "ready" } : { status: "failed", errorMessage: "The session was deleted while it was set up." });
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
          : provisionFailureMessage(error, phase, secrets, isMetered(provider.name));
    const settled = await settle({ status: "failed", errorMessage }).catch((updateError: unknown) => {
      console.error(`Workspace ${workspace.id} failure state could not be saved`, updateError);
      return true;
    });
    if (!settled) await releaseIfDeleted();
    await tell({ status: "failed", errorMessage });
  }
}

/**
 * The token for each repository the session clones, as its user chose
 * (lib/github/identity.ts): their own (undefined with none stored, which
 * only a private repository can't do without), or the App's, whose absence
 * is said now, with where to put it right, rather than on the box later.
 */
function gitTokenFor(userId: string, orgId: string, as?: typeof REVIEW_AS_APP) {
  return async (fullName: string): Promise<{ token: string | undefined } | { refusal: NextResponse }> => {
    try {
      return { token: await requireGitToken(userId, { orgId, fullName }, as) };
    } catch (error) {
      if (error instanceof GitIdentityError) {
        return { refusal: NextResponse.json({ error: error.message, settingsHref: error.href }, { status: 409 }) };
      }
      if (!(error instanceof MissingGithubTokenError)) {
        console.warn(`No GitHub token for ${fullName}'s session`, error);
      }
      return { token: undefined };
    }
  };
}

/**
 * GitHub's word on the stored token before a box is started to clone with
 * it, or null to go on: a token GitHub has since revoked or expired failed
 * the setup minutes later, on the box, with git's own message. Only a refusal
 * stops here; a rate limit or an outage is left to the clone.
 */
async function githubRefusal(
  githubToken: string | undefined,
  project: { fullName: string; private: boolean },
): Promise<NextResponse | null> {
  if (!githubToken) return null;
  try {
    if (await getGitHubRepository(githubToken, project.fullName)) return null;
    // Lost access, an organization's SSO, or the repository renamed or gone:
    // GitHub says only that it can't be seen. Logged, to tell them apart.
    console.warn(`GitHub can't see ${project.fullName} with its owner's token (private: ${project.private})`);
    if (!project.private) return null;
    return NextResponse.json(
      {
        error: `Your GitHub account can't see ${project.fullName} any more. Check its access on GitHub, or reconnect it in Settings → Account.`,
        reconnect: true,
        settingsHref: GITHUB_RECONNECT_HREF,
      },
      { status: 409 },
    );
  } catch (error) {
    // With the link the form shows: where signing in again happens.
    if (error instanceof GitHubReconnectError) {
      return NextResponse.json({ error: error.message, reconnect: true, settingsHref: GITHUB_RECONNECT_HREF }, { status: 409 });
    }
    console.warn(`Could not check the GitHub connection before ${project.fullName}'s session`, error);
    return null;
  }
}
