/**
 * An issue delegated to Outrunner, or Outrunner @mentioned on it: Linear's agent
 * session, and a session here that answers it (docs/linear-app.md).
 *
 * Linear wants the webhook answered within 5s and something said within 10s, and a
 * session takes minutes to start. So what's first said is said before the webhook
 * answers, where a failure can still make Linear deliver it again, and everything
 * else runs after (`defer`).
 *
 * Whose session it is: the person who delegated, if they've linked their account
 * and are in the org that owns the team. A Linear rule has no person behind it, so
 * an org admin has to have turned those on, and it runs as the issue's creator. It's
 * never the installer, or whoever set a rule here: no one in Outrunner chose to spend
 * their allowance on that. A slot of the team's day goes only as one really starts.
 *
 * One event acts on an issue at a time, whatever the way in: a delivery and its retry, a
 * delegation and an @mention close together, a follow-up during setup. A stop always wins:
 * a row never comes back from stopped by itself, and a session set up meanwhile is
 * interrupted once it's up.
 */

import { blockedTarget, type IssueState, startedTarget } from "@/lib/trackers/rules";
import type { AccessLevel } from "@/lib/orgs/access";
import { allows } from "@/lib/orgs/access";
import type { AgentRow } from "@/lib/db/linear-agent";
import type { TrackerInstallation, TrackerScope } from "@/lib/db/trackers";
import type { TrackerFiling, TrackerNote } from "@/lib/db/work-items";
import { OUTRUNNER_MODELS } from "@/lib/runtime/session-models";
import { SETTING_UP } from "@/lib/session/provisioning";
import type { ServerSessionResult, ServerSessionStart } from "@/lib/session/server-session";
import type { LinearActivity, LinearSignal, RepositorySuggestion } from "@/lib/trackers/linear";
import { branchHint } from "@/lib/trackers/issue-key";
import type { TriageActor } from "@/lib/triage/access";
import { cutText, MAX_BODY, MAX_TITLE, type WorkItem } from "@/lib/triage/work-items";

const SOURCE = "linear" as const;
/** How sure Linear has to be of a repository for it to pick without asking. */
export const SUGGESTION_CONFIDENCE = 0.8;
/** Linear's select shows these; a list past it is a long way to scroll. */
const MAX_OPTIONS = 25;
/** How many of Linear's guidance rules are kept while a question waits. */
const MAX_GUIDANCE = 20;

export const REPLIES = {
  busy: "Outrunner is still setting up this issue's session. Say that again once it's started.",
  ruleDeclined: "This issue was declined in Outrunner, so a rule won't start it. Delegating it yourself will.",
  notYours: "This question is for whoever delegated the issue, as it runs on their account.",
  empty: "That came through empty, so nothing was sent.",
  notYoursToRestart: "This would run on the account of whoever delegated the issue, so only they can start it again.",
  linkFirst: "Link your Linear account to Outrunner, then delegate this again.",
  nothingRunning: "Nothing was running.",
  closedSince: "This issue has closed since, so nothing started. Delegate it again if it's still wanted.",
  issuesOnly: "Outrunner works on issues. Delegate one, or mention Outrunner on it.",
  notConnected: "This team isn't connected to an Outrunner org. An org admin connects it under Settings → Org → Integrations → Linear.",
  rulesOff: "Rule-started sessions are off for this team in Outrunner.",
  noPerson: "This issue wasn't created by a person, so there's no one to run its session as.",
  notMember: "Your Linear account is linked, but you aren't in the Outrunner org this team belongs to.",
  noRepos: "You can't read any repository in the Outrunner org this team belongs to.",
  stopped: "Stopped.",
  stoppingOnceUp: "Its session is still being set up, so it stops once it's up.",
  cantSteer: "This session is someone else's, and you need write access to its repository to steer it.",
  link: "Link your Linear account to Outrunner, and this carries on.",
  linkThenSay: "Link your Linear account to Outrunner, then say that again.",
  stillAskingRepo: "This is still waiting to hear which repository to run on, from whoever asked first. Nothing has started.",
  stillAskingLink: "This is still waiting for whoever asked first to link their Linear account. Nothing has started.",
  whichRepo: "Which repository should this run on?",
  notARepo: "That isn't one of the repositories you can use. Which one should this run on?",
  sendFailed: "The session isn't answering, so that didn't reach it.",
} as const;

export function capReply(cap: number): string {
  return `This team's limit of ${cap} rule-started sessions today is reached.`;
}

export type Project = { id: string; fullName: string };

export type AgentDeps = {
  say(installationId: string, agentSessionId: string, content: LinearActivity, signal?: LinearSignal): Promise<void>;
  addUrl(installationId: string, agentSessionId: string, url: { label: string; url: string }): Promise<void>;
  setIssueState(installationId: string, issueId: string, stateId: string): Promise<void>;
  standing(installationId: string, issueId: string): Promise<{ teamId: string; open: boolean; stateId?: string | null; stateType: string | null; delegateId: string | null } | null>;
  creator(installationId: string, issueId: string): Promise<{ id: string; name: string | null } | null>;
  suggestions(installationId: string, issueId: string, agentSessionId: string, repositories: readonly string[]): Promise<RepositorySuggestion[]>;
  scopeForTeam(installationId: string, teamId: string): Promise<TrackerScope | null>;
  claimRuleSession(scopeId: string): Promise<boolean>;
  linkedOwner(installationId: string, externalUserId: string): Promise<string | null>;
  triageActor(userId: string, orgId: string): Promise<TriageActor | null>;
  projects(orgId: string): Promise<Project[]>;
  level(userId: string, projectId: string): Promise<AccessLevel | null>;
  item(orgId: string, sourceRef: string): Promise<WorkItem | null>;
  file(actor: TriageActor, filing: TrackerFiling, installationId: string): Promise<WorkItem | null>;
  linkItem(orgId: string, itemId: string, session: { workspaceId: string; projectId: string }): Promise<void>;
  addNote(orgId: string, itemId: string, note: TrackerNote): Promise<void>;
  row(agentSessionId: string): Promise<AgentRow | null>;
  /** The newest row of an issue: Linear keeps one agent session through un-delegating. */
  latestRow(installationId: string, issueId: string): Promise<AgentRow | null>;
  /** False, with nothing written, if a stop has landed since `seen`, the row this was decided
   *  from: see saveAgentRow. Nothing else changes a stage, but stopRow. */
  saveRow(row: AgentRow, seen: AgentRow | null, options?: { restart?: boolean }): Promise<boolean>;
  /** Its session, once made. Leaves the stage: a stop during setup stays a stop. */
  setRowWorkspace(agentSessionId: string, workspaceId: string): Promise<void>;
  stopRow(agentSessionId: string): Promise<void>;
  /** Hold the issue. Null: held now. Otherwise who has it. */
  claimIssue(installationId: string, issueId: string, holder: string): Promise<string | null>;
  releaseIssue(installationId: string, issueId: string, holder: string): Promise<void>;
  session(workspaceId: string): Promise<{ id: string; ownerId: string; projectId: string | null; status: string } | null>;
  start(start: ServerSessionStart): Promise<ServerSessionResult>;
  send(ownerId: string, workspaceId: string, text: string): Promise<boolean>;
  stop(ownerId: string, workspaceId: string): Promise<boolean>;
  /** A branch named for the issue, free in that project. */
  branchFor(projectId: string, key: string, title: string): Promise<string>;
  /** How long a stop waits on the session before saying it may still be running: the webhook
   *  it answers has 5s. */
  interruptWaitMs: number;
  /** Where its conversation is, before a send: activity after it is that send's turn. */
  sendBaseline(workspaceId: string): Promise<number | null>;
  /** A turn was sent: from now on the relay and the tick watch it. */
  openWatch(agentSessionId: string, sent: { sentAt: number; baselineActivity: number | null }): Promise<void>;
  /** Watch a while; the tick carries on after. */
  watchReply(agentSessionId: string): Promise<void>;
  now(): number;
  linkUrl(): string;
  sessionUrl(workspaceId: string): string;
  defer(work: () => Promise<unknown>): void;
};

/** As Linear sends it (AgentSessionEventWebhookPayload). */
export type AgentPayload = {
  /** Ours, not Linear's: what a reply added when it started this again. */
  said?: string | null;
  /** Who said it: it's only what names a repository or model for their own run. */
  saidBy?: string | null;
  action?: unknown;
  appUserId?: unknown;
  promptContext?: unknown;
  guidance?: unknown;
  agentSession?: {
    id?: unknown;
    creatorId?: unknown;
    creator?: { id?: unknown; name?: unknown } | null;
    issueId?: unknown;
    createdAt?: unknown;
    issue?: { id?: unknown; identifier?: unknown; teamId?: unknown; title?: unknown; description?: unknown; url?: unknown } | null;
    comment?: { id?: unknown; body?: unknown; userId?: unknown } | null;
    /** `{type: "comment"}` when an @mention opened it. */
    sourceMetadata?: { type?: unknown } | null;
  } | null;
  agentActivity?: {
    signal?: unknown;
    userId?: unknown;
    user?: { name?: unknown } | null;
    content?: { body?: unknown; type?: unknown } | null;
    body?: unknown;
  } | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Linear's editor stores what's typed as markdown: `[repo=a/b]` arrives as `\\[repo=a/b\\]`,
 *  in comments, replies and guidance alike. Code is left as written: a backslash there is
 *  what someone meant. */
export function withoutEscapes(text: string): string {
  return text.replace(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)|\\([\\`*_{}[\]()#+\-.!|>~])/g, (_match, code: string | undefined, escaped: string | undefined) => code ?? escaped ?? "");
}

/** What a tag is read from: a tag quoted in code isn't one being used. */
function tagText(text: string): string {
  return withoutEscapes(text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, " "));
}

const REPO_TAG = /\[repo=([\w.-]+\/[\w.-]+)\]/i;
const MODEL_TAG = /\[model=([^\]\s]+)\]/i;

/** A repository a text names, as [repo=owner/name], if the runner can read it. */
function taggedRepo(source: string | null, readable: readonly Project[]): Project | null {
  const name = source && tagText(source).match(REPO_TAG)?.[1]?.toLowerCase();
  return name ? (readable.find((p) => p.fullName.toLowerCase() === name) ?? null) : null;
}

/**
 * Which repository a delegation runs on, in order: a tag in their own words,
 * the item's own project, the team's default, a tag in Linear's guidance. Only
 * projects the runner can read count. Null: Linear's suggestion, then ask.
 * Prose in guidance isn't read for repositories: only a tag says so.
 */
export function pickRepo(input: {
  comment: string | null;
  itemProjectId: string | null;
  defaultProjectId: string | null;
  guidance: readonly string[];
  readable: readonly Project[];
}): Project | null {
  const byId = (id: string | null) => (id ? (input.readable.find((p) => p.id === id) ?? null) : null);
  return (
    taggedRepo(input.comment, input.readable) ??
    byId(input.itemProjectId) ??
    byId(input.defaultProjectId) ??
    input.guidance.map((g) => taggedRepo(g, input.readable)).find(Boolean) ??
    null
  );
}

/** The best of Linear's suggestions it's sure enough of, among what the runner can read. */
export function bestSuggestion(suggestions: readonly RepositorySuggestion[], readable: readonly Project[]): Project | null {
  const sure = suggestions.filter((s) => s.confidence >= SUGGESTION_CONFIDENCE).sort((a, b) => b.confidence - a.confidence);
  for (const suggestion of sure) {
    const found = readable.find((p) => p.fullName.toLowerCase() === suggestion.repositoryFullName.toLowerCase());
    if (found) return found;
  }
  return null;
}

/** The repository a reply to "which repository?" names, among what the runner can read. */
export function repoFromReply(reply: string | null, readable: readonly Project[]): Project | null {
  if (!reply) return null;
  const said = withoutEscapes(reply).toLowerCase();
  const tagged = taggedRepo(reply, readable);
  if (tagged) return tagged;
  // Longest first: a/app-web mustn't be taken for a/app.
  return [...readable].sort((a, b) => b.fullName.length - a.fullName.length).find((p) => said.includes(p.fullName.toLowerCase())) ?? null;
}

/**
 * The model a [model=…] tag asks for. A server-started session runs only on Outrunner's
 * models (lib/session/server-session.ts). An unknown one isn't worth stopping for: the
 * default runs, and the caller says so.
 */
export function pickModel(...sources: (string | null)[]): { model?: string; unknown?: string } {
  for (const source of sources) {
    const asked = source && tagText(source).match(MODEL_TAG)?.[1];
    if (!asked) continue;
    return OUTRUNNER_MODELS.some((m) => m.id === asked) ? { model: asked } : { unknown: asked };
  }
  return {};
}

/** The team's before the workspace's, whichever way round they come (Linear sends the
 *  workspace's first): the nearer one says more about this issue. */
function guidanceBodies(guidance: unknown): string[] {
  if (!Array.isArray(guidance)) return [];
  const rules = guidance as { body?: unknown; origin?: { type?: unknown } | null }[];
  const nearFirst = [...rules.filter((rule) => rule?.origin?.type === "Team"), ...rules.filter((rule) => rule?.origin?.type !== "Team")];
  return nearFirst.flatMap((rule) => {
    const body = text(rule?.body);
    return body ? [body] : [];
  });
}

/** The session's first prompt: the issue as Linear tells it, and its guidance. */
export function firstPrompt(payload: AgentPayload): string {
  const issue = payload.agentSession?.issue;
  const context = text(payload.promptContext);
  const guidance = guidanceBodies(payload.guidance).filter((body) => !context?.includes(body));
  const key = text(issue?.identifier);
  const parts = [`Work on Linear issue ${key ?? ""}: ${text(issue?.title) ?? "Untitled issue"}`.replace("  ", " ")];
  if (text(issue?.url)) parts.push(`(${text(issue?.url)})`);
  // The branch it's on already has it. Should the agent ever name its own, the link stays.
  if (key) parts.push(branchHint("linear", key));
  parts.push(context ?? text(issue?.description) ?? "");
  if (guidance.length) parts.push(["Guidance from Linear:", ...guidance.map((g) => `- ${g}`)].join("\n"));
  if (text(payload.said)) parts.push(`They added, in Linear: ${text(payload.said)}`);
  return cutText(parts.filter(Boolean).join("\n\n"), MAX_BODY);
}

/** Whose account it would run on. */
type Runner = {
  actor: TriageActor;
  ruleStarted: boolean;
  /** Their Linear id, when known: whose words count as theirs. */
  externalId: string | null;
  /** A slot of the day's already spent on this. */
  slotTaken?: boolean;
};

/**
 * What can name a repository or model, on the runner's account and allowance: their own words,
 * and only those. Not the description, even of an issue they made: anyone who can edit it can
 * edit that, and someone else mustn't pick where they run. Guidance is an admin's, and is read
 * apart.
 */
function tagWords({ payload }: Context, runner: Runner): string | null {
  const comment = payload.agentSession?.comment;
  const theirComment = runner.externalId && text(comment?.userId) === runner.externalId ? text(comment?.body) : null;
  const theirReply = runner.externalId && text(payload.saidBy) === runner.externalId ? text(payload.said) : null;
  return [theirReply, theirComment].filter(Boolean).join("\n") || null;
}

/** What's worth keeping of a delegation, capped: a later event needn't repeat it. */
export function askOf(payload: AgentPayload): AgentPayload {
  const session = payload.agentSession;
  const issue = session?.issue;
  const capped = (value: unknown) => (typeof value === "string" ? cutText(value, MAX_BODY) : value);
  return {
    said: typeof payload.said === "string" ? cutText(payload.said, MAX_BODY) : null,
    saidBy: payload.saidBy,
    promptContext: capped(payload.promptContext),
    guidance: guidanceBodies(payload.guidance).slice(0, MAX_GUIDANCE).map((body) => ({ body: cutText(body, MAX_BODY) })),
    agentSession: {
      id: session?.id,
      createdAt: session?.createdAt,
      creatorId: session?.creatorId,
      creator: session?.creator,
      issueId: session?.issueId,
      issue: issue ? { ...issue, description: capped(issue.description) } : issue,
      comment: session?.comment ? { id: session.comment.id, userId: session.comment.userId, body: capped(session.comment.body) } : session?.comment,
      sourceMetadata: session?.sourceMetadata?.type === "comment" ? { type: "comment" } : null,
    },
  };
}

type Context = {
  installation: TrackerInstallation;
  agentSessionId: string;
  payload: AgentPayload;
  deps: AgentDeps;
  /** Someone asked again after a stop: that stop isn't what this one answers to. */
  restart?: boolean;
  /** Just delegated: it may be taken back before there's a row saying so for an un-delegate to
   *  find, as a first one has no row, and a re-delegation's stays stopped until it's written. */
  justDelegated?: boolean;
  /** The payload was kept from earlier, so what it says of the issue may have changed. */
  kept?: boolean;
};

function promptOfActivity(payload: AgentPayload): string | null {
  return text(payload.agentActivity?.content?.body) ?? text(payload.agentActivity?.body);
}

/** Handle the event: what's said here runs before the webhook answers. */
export async function handleAgentEvent(installation: TrackerInstallation, payload: AgentPayload, deps: AgentDeps): Promise<{ handled: boolean; reason?: string }> {
  const agentSessionId = text(payload.agentSession?.id);
  if (!agentSessionId) return { handled: false, reason: "no agent session" };
  const context: Context = { installation, agentSessionId, payload, deps };
  const say = (content: LinearActivity, signal?: LinearSignal) => deps.say(installation.id, agentSessionId, content, signal);

  if (payload.action === "created") {
    if (!issueIdOf(payload)) {
      await say({ type: "response", body: REPLIES.issuesOnly });
      return { handled: true };
    }
    // A delivery again, of one that got as far as saying where it stands.
    if (await deps.row(agentSessionId)) return { handled: true };
    await say({ type: "thought", body: "Looking at this issue." });
    deps.defer(() => guarded(context, DIDNT_START, () => holdingIssue(context, { whenHeld: "silent-if-mine" }, async () => {
      // It may have finished while this waited, or been stopped.
      if (await deps.row(agentSessionId)) return false;
      return delegate({ ...context, justDelegated: true });
    })));
    return { handled: true };
  }

  if (payload.action === "prompted") {
    if (payload.agentActivity?.signal === "stop") {
      await stopHere(context);
      return { handled: true };
    }
    await say({ type: "thought", body: "On it." });
    deps.defer(() => guarded(context, DIDNT_REACH, () => prompted(context)));
    return { handled: true };
  }
  return { handled: false, reason: "not an agent action" };
}

/** How far from its session's making an issue change is that delegation's own, by Linear's
 *  clock. Seen: within 0.1s; a later delegation, not within 7s, even by a script. */
const SAME_DELEGATION_MS = 3000;

/**
 * Whether this delegation is news to the row, rather than the one that made it. A first
 * delegation's own issue change comes with its `created`, and may find it already refused or
 * stopped: that isn't someone asking again, and would answer twice.
 */
function delegatedSince(row: AgentRow | null, at: number | null): row is AgentRow {
  if (!row || (row.stage !== "stopped" && !(row.stage === "working" && row.fromMention))) return false;
  return !sameDelegation(row, at);
}

function sameDelegation(row: AgentRow, at: number | null): boolean {
  return Boolean(at !== null && row.sessionCreatedAt && Math.abs(at - row.sessionCreatedAt) < SAME_DELEGATION_MS);
}

/**
 * Delegated again, or delegated after an @mention, stopped or not. Linear keeps the agent
 * session it had, whatever state that's in, and sends no agent event: only the issue's own
 * change says so. So the row is what tells this from a first delegation.
 *
 * A first delegation's `created`, for this session or another, may be under way, so this
 * takes the same hold, and looks again once it has it. Whichever comes first, one acts, and
 * the other finds a session to tell rather than starting one. Its own change was ruled out
 * above, so held, this is someone asking while it's busy: they hear so.
 */
export async function handleRedelegated(
  installation: TrackerInstallation,
  again: { issueId: string; actorId: string | null; actorName: string | null; at?: number | null; issue: NonNullable<NonNullable<AgentPayload["agentSession"]>["issue"]> },
  deps: AgentDeps,
): Promise<void> {
  const at = again.at ?? null;
  const row = await deps.latestRow(installation.id, again.issueId);
  // A question's waiting on someone, and this doesn't answer it: whoever just delegated should
  // know why nothing's happening.
  if (row && (row.stage === "awaiting_repo" || row.stage === "awaiting_link") && at !== null && !sameDelegation(row, at)) {
    await deps.say(installation.id, row.agentSessionId, { type: "response", body: row.stage === "awaiting_repo" ? REPLIES.stillAskingRepo : REPLIES.stillAskingLink });
    return;
  }
  if (!delegatedSince(row, at)) return;
  // What someone added for their own restart isn't for whoever delegates it next.
  const theirs = again.actorId !== null && text(row.ask?.saidBy) === again.actorId;
  const payload: AgentPayload = {
    ...row.ask,
    said: theirs ? row.ask?.said : null,
    saidBy: theirs ? row.ask?.saidBy : null,
    action: "created",
    agentSession: {
      ...row.ask?.agentSession,
      id: row.agentSessionId,
      createdAt: row.sessionCreatedAt ? new Date(row.sessionCreatedAt).toISOString() : row.ask?.agentSession?.createdAt,
      issueId: again.issueId,
      issue: again.issue,
      creatorId: again.actorId,
      creator: again.actorId ? { id: again.actorId, name: again.actorName } : null,
      // It's a delegated one from here on.
      sourceMetadata: null,
    },
  };
  const context: Context = { installation, agentSessionId: row.agentSessionId, payload, deps, restart: true, justDelegated: true };
  await guarded(context, DIDNT_START, () =>
    holdingIssue(context, { whenHeld: "say" }, async () => {
      const now = await deps.latestRow(installation.id, again.issueId);
      if (now?.agentSessionId !== row.agentSessionId || !delegatedSince(now, at)) return false;
      await deps.say(installation.id, row.agentSessionId, { type: "thought", body: "Looking at this issue." });
      return delegate(context);
    }),
  );
}

/** Someone just linked: what they asked for carries on, as first asked. */
export async function resumeAfterLink(installation: TrackerInstallation, row: AgentRow, deps: AgentDeps): Promise<void> {
  if (!row.ask) return;
  const context: Context = { installation, agentSessionId: row.agentSessionId, payload: row.ask, deps, kept: true };
  // It may be a day later: what was asked may be over.
  const standing = await deps.standing(installation.id, row.issueId);
  if (!standing) return;
  // Only if it's closed since: someone may well ask about an issue that's closed.
  if (!standing.open && row.openWhenAsked) {
    await deps.stopRow(row.agentSessionId);
    await deps.say(installation.id, row.agentSessionId, { type: "response", body: REPLIES.closedSince });
    return;
  }
  await deps.say(installation.id, row.agentSessionId, { type: "thought", body: "Linked. Looking at this issue." });
  await guarded(context, DIDNT_START, () => holdingIssue(context, { whenHeld: "say" }, () => delegate(context)));
}

/**
 * Act only while holding the issue, which lasts until a session is up or a send has gone.
 * `work` says whether there's a turn to watch, which is done after letting go. Held by this
 * same agent session, a delivery's retry
 * (`retrySilent`) has nothing to add. Anything else was said by someone: they hear why it
 * didn't go anywhere.
 */
async function holdingIssue(context: Context, { whenHeld }: { whenHeld: "say" | "silent-if-mine" }, work: () => Promise<boolean>): Promise<void> {
  const { installation, agentSessionId, payload, deps } = context;
  const issueId = issueIdOf(payload) as string;
  const holder = await deps.claimIssue(installation.id, issueId, agentSessionId);
  if (holder !== null) {
    if (whenHeld === "say" || holder !== agentSessionId) await deps.say(installation.id, agentSessionId, { type: "response", body: REPLIES.busy });
    return;
  }
  let watching = false;
  try {
    watching = await work();
  } finally {
    await deps.releaseIssue(installation.id, issueId, agentSessionId).catch((error: unknown) => console.error("Linear: couldn't let go of an issue", error));
  }
  // Outside the hold: it's up, so what anyone says next has somewhere to go.
  if (watching) await deps.watchReply(agentSessionId).catch((error: unknown) => console.error("Linear: couldn't watch a turn", error));
}

function issueIdOf(payload: AgentPayload): string | null {
  return text(payload.agentSession?.issue?.id) ?? text(payload.agentSession?.issueId);
}

const DIDNT_START = "Something went wrong in Outrunner, so this didn't start. Try again.";
const DIDNT_REACH = "Something went wrong in Outrunner, so that didn't reach the session. Try again.";

/** After the answer, nothing can make Linear deliver it again: say what went wrong. */
async function guarded(context: Context, failure: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error("Linear: a delegation failed", error);
    await context.deps
      .say(context.installation.id, context.agentSessionId, { type: "error", body: failure })
      .catch((sayError: unknown) => console.error("Linear: couldn't say a delegation failed", sayError));
  }
}

/** Waits on `work` for so long, then answers `fallback`. */
export async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stopped first, so a session still being set up is interrupted once it's up, and nothing
 *  more goes to Linear. Only said to have stopped if it did. A stop with no row yet is one
 *  during the first moments of a delegation: it's written, for that to find. */
async function stopHere(context: Context): Promise<void> {
  const { installation, agentSessionId, payload, deps } = context;
  const say = (content: LinearActivity) => deps.say(installation.id, agentSessionId, content);
  const row = await deps.row(agentSessionId);
  if (!row) {
    if (!issueIdOf(payload)) {
      await say({ type: "response", body: REPLIES.nothingRunning });
      return;
    }
    // A row that's appeared since is stopped as any other. What wrote it finds the mark.
    if (!(await deps.saveRow(rowOf(context, { stage: "stopped" }), null))) await deps.stopRow(agentSessionId);
    await say({ type: "response", body: REPLIES.stopped });
    return;
  }
  await deps.stopRow(agentSessionId);
  if (row.stage === "working" && row.workspaceId && row.ownerId) {
    // What's starting it looks once it's up. There's no turn to stop until then.
    const session = await deps.session(row.workspaceId).catch(() => null);
    if (session && SETUP_STATUSES.has(session.status)) {
      await say({ type: "response", body: REPLIES.stoppingOnceUp });
      return;
    }
    const stopped = await within(deps.stop(row.ownerId, row.workspaceId), deps.interruptWaitMs, false);
    if (!stopped) {
      await say({
        type: "error",
        body: `Outrunner couldn't stop the turn, so it may still be running, and nothing more will come here from it. Stop it from the session: ${deps.sessionUrl(row.workspaceId)}`,
      });
      return;
    }
  }
  await say({ type: "response", body: REPLIES.stopped });
}

/** Who a delegation runs as, having said why when it's no one. No slot of the day yet: that
 *  goes only as a session really starts. */
async function resolveRunner(context: Context, scope: TrackerScope, seen: AgentRow | null): Promise<Runner | null> {
  const { installation, agentSessionId, payload, deps } = context;
  const say = (content: LinearActivity, signal?: LinearSignal) => deps.say(installation.id, agentSessionId, content, signal);
  const issueId = issueIdOf(payload) as string;
  const delegator = text(payload.agentSession?.creatorId) ?? text(payload.agentSession?.creator?.id);
  const human = Boolean(delegator) && delegator !== installation.appUserId;

  let externalId = delegator as string;
  if (!human) {
    if (!scope.acceptRuleSessions) {
      await refuse(context, scope.orgId, REPLIES.rulesOff, true);
      return null;
    }
    const creator = await deps.creator(installation.id, issueId);
    if (!creator || creator.id === installation.appUserId) {
      await refuse(context, scope.orgId, REPLIES.noPerson, true);
      return null;
    }
    externalId = creator.id;
  }

  const owner = await deps.linkedOwner(installation.id, externalId);
  if (!owner) {
    // Someone else's session or question stays theirs: this one is told to ask again after.
    const inUse = isInUse(seen);
    if (!inUse) {
      const written = await deps.saveRow(rowOf(context, { orgId: scope.orgId, teamId: scope.externalTeamId, openWhenAsked: await openNow(context), stage: "awaiting_link", prompt: firstPrompt(payload), ruleStarted: !human, ask: askOf(payload), askedUser: externalId }), seen, { restart: context.restart });
      if (!written || (await stopIfTakenBack(context))) return null;
      await moveIssue(context, scope, issueId, blockedTarget, "blocked");
    }
    await say({ type: "elicitation", body: inUse ? REPLIES.linkFirst : REPLIES.link }, { signal: "auth", signalMetadata: { url: deps.linkUrl(), userId: externalId, providerName: "Outrunner" } });
    return null;
  }
  const actor = await deps.triageActor(owner, scope.orgId);
  if (!actor) {
    await refuse(context, scope.orgId, REPLIES.notMember, !human);
    return null;
  }
  return { actor, ruleStarted: !human, externalId };
}

function rowOf(context: Context, over: Partial<AgentRow>): AgentRow {
  return {
    agentSessionId: context.agentSessionId,
    installationId: context.installation.id,
    orgId: null,
    issueId: issueIdOf(context.payload) as string,
    itemId: null,
    workspaceId: null,
    ownerId: null,
    stage: "working",
    prompt: null,
    ruleStarted: false,
    ask: null,
    askedUser: null,
    fromMention: context.payload.agentSession?.sourceMetadata?.type === "comment",
    sessionCreatedAt: createdAtOf(context.payload),
    ...over,
  };
}

function createdAtOf(payload: AgentPayload): number | null {
  const at = text(payload.agentSession?.createdAt);
  const parsed = at ? Date.parse(at) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** A row whose session or question is someone's: a refusal or a request to link for another
 *  person mustn't write over it. */
function isInUse(row: AgentRow | null): boolean {
  return row !== null && (row.workspaceId !== null || row.stage === "awaiting_repo");
}

/** Say why nothing started, leaving a row if there's none: Linear reuses this session if they
 *  delegate again once they've fixed it, and says so only on the issue. One already there
 *  keeps everything: its session, its owner, what was asked. */
async function refuse(context: Context, orgId: string | null, body: string, ruleStarted = false): Promise<false> {
  const { installation, agentSessionId, payload, deps } = context;
  await deps.saveRow(rowOf(context, { orgId, stage: "stopped", ruleStarted, ask: askOf(payload) }), null);
  await deps.say(installation.id, agentSessionId, { type: "response", body });
  return false;
}

async function teamScope(context: Context): Promise<TrackerScope | null> {
  const { installation, payload, deps, kept } = context;
  const issueId = issueIdOf(payload) as string;
  // Kept while a question waited, the issue may have moved to another team, or org, since.
  const teamId = (kept ? null : text(payload.agentSession?.issue?.teamId)) ?? (await deps.standing(installation.id, issueId))?.teamId ?? null;
  return teamId ? deps.scopeForTeam(installation.id, teamId) : null;
}

/** A new delegation or @mention: route it, and start or steer a session. Holding the issue.
 *  Whether there's now a turn to watch. */
async function delegate(context: Context): Promise<boolean> {
  const { installation, agentSessionId, payload, deps } = context;
  // What everything below is decided from: a stop after this means none of it goes through.
  const existing = await deps.row(agentSessionId);
  const scope = await teamScope(context);
  if (!scope) {
    return refuse(context, null, REPLIES.notConnected);
  }
  const runner = await resolveRunner(context, scope, existing);
  if (!runner) return false;
  if (existing?.slotTaken) runner.slotTaken = true;

  const issueId = issueIdOf(payload) as string;
  const item = await deps.item(scope.orgId, `${SOURCE}:${issueId}`);
  // A person may hand back what was decided here. A rule can't overrule them.
  if (runner.ruleStarted && (item?.status === "declined" || item?.status === "duplicate")) {
    return refuse(context, scope.orgId, REPLIES.ruleDeclined, true);
  }
  const prompt = firstPrompt(payload);

  // Handed back to a session it already has: restored if it must be, and told. The row may
  // know one its item doesn't.
  const mine = existing?.orgId === scope.orgId ? existing : null;
  const workspaceId = item?.workspaceId ?? mine?.workspaceId ?? null;
  if (workspaceId) {
    const steered = await steerExisting(context, scope, runner, item, workspaceId, existing, prompt);
    if (steered === "sent") return true;
    if (steered === "stopped") return false;
    if (steered === "busy") {
      await deps.say(context.installation.id, context.agentSessionId, { type: "response", body: REPLIES.busy });
      return false;
    }
    if (steered === "capped") return refuse(context, scope.orgId, capReply(scope.ruleSessionsPerDay), true);
    if (steered === "refused") return refuse(context, scope.orgId, REPLIES.cantSteer, runner.ruleStarted);
  }

  const projects = await deps.projects(scope.orgId);
  const readable = projects.filter((p) => runner.actor.levels.has(p.id));
  if (readable.length === 0) {
    return refuse(context, scope.orgId, REPLIES.noRepos, runner.ruleStarted);
  }
  const settled = pickRepo({
      // What they've just said counts before what was first asked.
      comment: tagWords(context, runner),
      itemProjectId: item?.projectId ?? null,
      defaultProjectId: scope.defaultProjectId,
      guidance: guidanceBodies(payload.guidance),
      readable,
    });
  // It reads the description and comments, as a tag there can't: only on an issue that's theirs,
  // and it says so before it runs, as someone else's comment may have swayed it.
  const suggested =
    !settled && runner.externalId && (await deps.creator(installation.id, issueId).catch(() => null))?.id === runner.externalId
      ? bestSuggestion(await deps.suggestions(installation.id, issueId, agentSessionId, readable.map((p) => p.fullName)).catch(() => []), readable)
      : null;
  const picked = settled ?? suggested;

  if (!picked) {
    const written = await deps.saveRow(rowOf(context, { orgId: scope.orgId, teamId: scope.externalTeamId, openWhenAsked: await openNow(context), slotTaken: runner.slotTaken, itemId: item?.id ?? null, ownerId: runner.actor.userId, stage: "awaiting_repo", prompt, ruleStarted: runner.ruleStarted, ask: askOf(payload) }), existing, { restart: context.restart });
    if (!written || (await stopIfTakenBack(context))) return false;
    await moveIssue(context, scope, issueId, blockedTarget, "blocked");
    await askRepo(context, readable, REPLIES.whichRepo);
    return false;
  }
  if (suggested) await deps.say(installation.id, agentSessionId, { type: "thought", body: `Running on ${suggested.fullName}, which Linear suggested from this issue. Stop this if that's wrong.` });
  return startSession(context, scope, runner, item, picked, prompt, existing);
}

function askRepo({ installation, agentSessionId, deps }: Context, readable: readonly Project[], body: string): Promise<void> {
  const options = readable.slice(0, MAX_OPTIONS).map((p) => ({ label: p.fullName, value: p.fullName }));
  return deps.say(installation.id, agentSessionId, { type: "elicitation", body }, { signal: "select", signalMetadata: { options } });
}

/** Whether someone may steer a session: its owner, or with write on its repository. */
async function maySteer(deps: AgentDeps, userId: string, session: { ownerId: string; projectId: string | null }): Promise<boolean> {
  if (session.ownerId === userId) return true;
  return session.projectId ? allows(await deps.level(userId, session.projectId), "write") : false;
}

/** A session in one of these isn't live: nothing it holds is worth protecting. */
const SETUP_STATUSES: ReadonlySet<string> = new Set(SETTING_UP);
const DEAD_STATUSES: ReadonlySet<string> = new Set(["archived", "archiving", "destroying", "destroyed"]);

/**
 * Send to the session the item has. `refused`: it's someone else's and live, and isn't
 * taken over: starting another would cut its PRs off from the item. `none`: there's nothing
 * to reach, or it couldn't be, so a new one starts.
 */
async function steerExisting(
  context: Context,
  scope: TrackerScope,
  runner: Runner,
  item: WorkItem | null,
  workspaceId: string,
  existing: AgentRow | null,
  prompt: string,
): Promise<"sent" | "refused" | "capped" | "busy" | "stopped" | "none"> {
  const { deps } = context;
  const session = await deps.session(workspaceId);
  if (!session) return "none";
  // Nothing can reach it yet, and it isn't lost: starting another would be two.
  if (SETUP_STATUSES.has(session.status) && (await maySteer(deps, runner.actor.userId, session))) return "busy";
  if (DEAD_STATUSES.has(session.status)) {
    // Asked of someone who may steer it, an archived one can be brought back. Nothing else
    // here can: it's gone.
    if (session.status !== "archived" || !(await maySteer(deps, runner.actor.userId, session))) return "none";
  } else if (!(await maySteer(deps, runner.actor.userId, session))) {
    return "refused";
  }
  // A rule steers only what its runner owns: anyone else's session may be on their own keys.
  // An archived one's gone, so a new one starts instead, on its own slot. It's still work a
  // rule started, so it counts against the day.
  if (runner.ruleStarted) {
    if (session.ownerId !== runner.actor.userId) return session.status === "archived" ? "none" : "refused";
    if (!runner.slotTaken && !(await deps.claimRuleSession(scope.id))) return "capped";
    runner.slotTaken = true;
  }
  const wasOpen = await openNow(context);
  const baselineActivity = await deps.sendBaseline(session.id).catch(() => null);
  const sentAt = deps.now();
  // What was first asked stays: a restart runs as whoever asked, not whoever steered it last.
  const next = rowOf(context, { orgId: scope.orgId, teamId: scope.externalTeamId, itemId: item?.id ?? existing?.itemId ?? null, workspaceId: session.id, ownerId: session.ownerId, ask: existing?.ask ?? askOf(context.payload) });
  // Written before it goes: a Stop pressed while it's on its way is one to find. With no row,
  // there's nothing to put back if it doesn't, and a Stop writes its own.
  if (existing && !(await deps.saveRow(next, existing, { restart: context.restart }))) return "stopped";
  if (!(await deps.send(session.ownerId, session.id, prompt).catch(() => false))) {
    if (existing) await deps.saveRow(existing, existing, { restart: true });
    return "none";
  }
  const stopped = existing ? (await deps.row(context.agentSessionId))?.stage === "stopped" : !(await deps.saveRow(next, null));
  if (stopped || (await stopIfTakenBack(context))) {
    await deps.stop(session.ownerId, session.id).catch((error: unknown) => console.warn("Linear: couldn't interrupt a session stopped as it was told", error));
    return "stopped";
  }
  if (wasOpen && (await closedSince(context, scope, item, session.ownerId, session.id))) return "stopped";
  if (item && session.projectId) await deps.linkItem(scope.orgId, item.id, { workspaceId: session.id, projectId: session.projectId });
  await deps.addUrl(context.installation.id, context.agentSessionId, { label: "Outrunner session", url: deps.sessionUrl(session.id) }).catch(() => undefined);
  await deps.openWatch(context.agentSessionId, { sentAt, baselineActivity });
  await moveToStarted(context, scope, issueIdOf(context.payload) as string);
  return "sent";
}

/**
 * Un-delegated before there was a row for that to stop: its event has only the issue, and finds
 * nothing. So once there's a row, Linear's asked: if it changed before this, this sees it, and
 * if after, its event finds the row. An @mention isn't a delegation, and doesn't need one.
 */
async function stopIfTakenBack(context: Context): Promise<boolean> {
  const { installation, agentSessionId, payload, deps, justDelegated } = context;
  if (!justDelegated || payload.agentSession?.sourceMetadata?.type === "comment") return false;
  const standing = await deps.standing(installation.id, issueIdOf(payload) as string).catch(() => null);
  if (!standing || standing.delegateId === installation.appUserId) return false;
  await deps.stopRow(agentSessionId);
  return true;
}

/** Whether the issue's open, as far as can be told. */
async function openNow({ installation, payload, deps }: Context): Promise<boolean> {
  return (await deps.standing(installation.id, issueIdOf(payload) as string).catch(() => null))?.open === true;
}

/**
 * Closed while this was on its way: archiving passes over a session still being set up, so it's
 * for this to stop. Only if it was open when this began: someone may well ask about an issue
 * that's closed. The session stays.
 */
async function closedSince(context: Context, scope: TrackerScope, item: WorkItem | null, ownerId: string, workspaceId: string): Promise<boolean> {
  const { installation, agentSessionId, payload, deps } = context;
  const standing = await deps.standing(installation.id, issueIdOf(payload) as string).catch(() => null);
  if (!standing || standing.open) return false;
  await deps.stopRow(agentSessionId);
  await deps.stop(ownerId, workspaceId).catch((error: unknown) => console.warn("Linear: couldn't interrupt a session whose issue closed", error));
  if (item) {
    await deps.addNote(scope.orgId, item.id, {
      authorId: null,
      body: "The issue closed as its session was starting, so its turn stopped. The session stays.",
      source: SOURCE,
      sourceUrl: text(payload.agentSession?.issue?.url),
      author: "Linear",
      sourceRef: `${SOURCE}:${agentSessionId}:closed:${workspaceId}`,
    });
  }
  await deps.say(installation.id, agentSessionId, { type: "response", body: REPLIES.closedSince });
  return true;
}

/** Start a session, with an item in progress on it, and keep Linear in step. A rule's takes
 *  a slot of the team's day here, and nowhere sooner. */
async function startSession(context: Context, scope: TrackerScope, runner: Runner, existing: WorkItem | null, project: Project, prompt: string, seen: AgentRow | null): Promise<boolean> {
  const { installation, agentSessionId, payload, deps } = context;
  const actor = runner.actor;
  const issue = payload.agentSession?.issue;
  const issueId = issueIdOf(payload) as string;
  const ref = `${SOURCE}:${issueId}`;
  const title = cutText((text(issue?.title) ?? "Untitled issue").replace(/\s+/g, " "), MAX_TITLE);

  // Stopped while this was deciding: it isn't to start, and nothing's been spent.
  const now = await deps.row(agentSessionId);
  if (seen ? (now?.stopMark ?? null) !== (seen.stopMark ?? null) : now) return false;
  if (runner.ruleStarted && !runner.slotTaken && !(await deps.claimRuleSession(scope.id))) return refuse(context, scope.orgId, capReply(scope.ruleSessionsPerDay), true);

  const { model, unknown } = pickModel(tagWords(context, runner));
  if (unknown) {
    await deps.say(installation.id, agentSessionId, {
      type: "thought",
      body: `There's no model called ${unknown} here, so this runs on the default. Available: ${OUTRUNNER_MODELS.map((m) => m.id).join(", ")}.`,
    });
  }

  const item =
    existing ??
    (await deps.file(
      actor,
      {
        title,
        body: cutText(text(issue?.description) ?? "", MAX_BODY),
        projectId: project.id,
        source: SOURCE,
        sourceUrl: text(issue?.url),
        sourceRef: ref,
        sourceAuthor: text(payload.agentSession?.creator?.name),
      },
      installation.id,
    )) ??
    (await deps.item(scope.orgId, ref));

  const written = await deps.saveRow(rowOf(context, { orgId: scope.orgId, teamId: scope.externalTeamId, itemId: item?.id ?? null, ownerId: actor.userId, stage: "working", ruleStarted: runner.ruleStarted, ask: askOf(payload) }), seen, { restart: context.restart });
  if (!written || (await stopIfTakenBack(context))) return false;
  const wasOpen = await openNow(context);
  const sentAt = deps.now();
  const key = text(issue?.identifier);
  const result = await deps.start({
    userId: actor.userId,
    projectId: project.id,
    title,
    prompt,
    model,
    source: SOURCE,
    ...(key && { branch: await deps.branchFor(project.id, key, title) }),
    onCreated: async (workspaceId) => {
      // Not the stage: a stop since stays a stop.
      await deps.setRowWorkspace(agentSessionId, workspaceId);
      if (item) await deps.linkItem(scope.orgId, item.id, { workspaceId, projectId: project.id });
      if ((await deps.row(agentSessionId))?.stage === "stopped") return;
      // Watched from here, so a setup that outlasts this process still has its end told.
      await deps.openWatch(agentSessionId, { sentAt, baselineActivity: null });
      await deps.addUrl(installation.id, agentSessionId, { label: "Outrunner session", url: deps.sessionUrl(workspaceId) }).catch((error: unknown) => console.warn("Linear: couldn't link the session", error));
      await moveToStarted(context, scope, issueId);
    },
  });

  // Stopped or un-delegated during its setup, its prompt went out regardless: it stops now.
  const stoppedSince = (await deps.row(agentSessionId))?.stage === "stopped";
  if (result.status === "ready") {
    if (!stoppedSince) return !(wasOpen && (await closedSince(context, scope, item, actor.userId, result.workspaceId)));
    await deps.stop(actor.userId, result.workspaceId).catch((error: unknown) => console.warn("Linear: couldn't interrupt a session stopped during setup", error));
    return false;
  }
  if (stoppedSince) return false;
  const reason = result.errorMessage ?? "Its setup failed.";
  await deps.stopRow(agentSessionId);
  await moveIssue(context, scope, issueId, blockedTarget, "blocked");
  await deps.say(installation.id, agentSessionId, {
    type: "error",
    body: result.workspaceId ? `The session couldn't start: ${reason}\n\n${deps.sessionUrl(result.workspaceId)}` : `The session couldn't start: ${reason}`,
  });
  if (item) {
    await deps.addNote(scope.orgId, item.id, {
      authorId: null,
      body: `The session couldn't start: ${reason}`,
      source: SOURCE,
      sourceUrl: text(issue?.url),
      author: "Linear",
      sourceRef: `${SOURCE}:${agentSessionId}:failed`,
    });
  }
  return false;
}

/** The team's state for work started, unless the issue is already past it. */
function moveToStarted(context: Context, scope: TrackerScope, issueId: string): Promise<void> {
  return moveIssue(context, scope, issueId, startedTarget, "started");
}

/** Move the issue as `target` says, from where it is now (lib/trackers/rules.ts). Best effort:
 *  the work goes on whether or not Linear moves. */
async function moveIssue(
  { installation, deps }: Context,
  scope: TrackerScope,
  issueId: string,
  target: (map: TrackerScope["stateMap"], issue: IssueState) => string | null,
  what: string,
): Promise<void> {
  if (!scope.stateMap) return;
  try {
    const standing = await deps.standing(installation.id, issueId);
    const state = standing ? target(scope.stateMap, standing) : null;
    if (state) await deps.setIssueState(installation.id, issueId, state);
  } catch (error) {
    console.warn(`Linear: couldn't move an issue to ${what}`, error);
  }
}

/** Someone said something in the agent session. */
async function prompted(context: Context): Promise<void> {
  const { installation, agentSessionId, payload, deps } = context;
  const say = (content: LinearActivity, signal?: LinearSignal) => deps.say(installation.id, agentSessionId, content, signal);
  const row = await deps.row(agentSessionId);
  const reply = promptOfActivity(payload);
  // What was first asked: this event needn't repeat it.
  const asked: Context = { ...(row?.ask ? { ...context, payload: row.ask, kept: true } : context), restart: row?.stage === "stopped" };
  // Starting it again: only by whoever it runs as, and what they just said goes with it.
  const startAgain = async (): Promise<void> => {
    if (!(await mayStartAgain(context, asked, row))) return;
    const said = reply?.trim() ? withoutEscapes(reply) : null;
    const withReply: Context = said ? { ...asked, payload: { ...asked.payload, said, saidBy: text(payload.agentActivity?.userId) } } : asked;
    await holdingIssue(withReply, { whenHeld: "say" }, () => delegate(withReply));
  };

  // Not known here, or asked to link: start over, as they may have now.
  if (!row || row.stage === "awaiting_link") {
    await startAgain();
    return;
  }

  if (row.stage === "awaiting_repo") {
    await holdingIssue(asked, { whenHeld: "say" }, () => answerRepo(context, asked, row, reply));
    return;
  }

  // Asked again during setup is `busy`. A row left with no session is a start that died.
  if (!row.workspaceId) {
    await startAgain();
    return;
  }
  const session = await deps.session(row.workspaceId);
  if (!session) {
    await startAgain();
    return;
  }
  // Disconnected, or moved to another org: the relay would only stop, saying nothing.
  const scope = await teamScope(asked);
  if (!scope || scope.orgId !== row.orgId) {
    await say({ type: "response", body: REPLIES.notConnected });
    return;
  }
  const speaker = text(payload.agentActivity?.userId);
  const speakerOwner = speaker ? await deps.linkedOwner(installation.id, speaker) : null;
  if (!speakerOwner || !(await maySteer(deps, speakerOwner, session))) {
    await say({ type: "response", body: speakerOwner ? REPLIES.cantSteer : REPLIES.linkThenSay });
    return;
  }
  if (!reply?.trim()) {
    await say({ type: "response", body: REPLIES.empty });
    return;
  }
  // Nothing can reach it yet, and it isn't lost.
  if (SETUP_STATUSES.has(session.status)) {
    await say({ type: "response", body: REPLIES.busy });
    return;
  }
  const name = text(payload.agentActivity?.user?.name);
  const baselineActivity = await deps.sendBaseline(session.id).catch(() => null);
  const sentAt = deps.now();
  const said = withoutEscapes(reply);
  // Someone asked for more: a stopped one is theirs to start again. Written before it goes, so
  // a Stop pressed while it's on its way is one to find. A newer Stop than this read stands.
  if (row.stage === "stopped" && !(await deps.saveRow({ ...row, stage: "working" }, row, { restart: true }))) return;
  const sent = await deps.send(session.ownerId, session.id, name ? `${name} (in Linear): ${said}` : said).catch(() => false);
  if (!sent) {
    if (row.stage === "stopped") await deps.saveRow(row, row, { restart: true });
    await say({ type: "error", body: REPLIES.sendFailed });
    return;
  }
  if ((await deps.row(agentSessionId))?.stage === "stopped") {
    await deps.stop(session.ownerId, session.id).catch((error: unknown) => console.warn("Linear: couldn't interrupt a session stopped as it was told", error));
    return;
  }
  await deps.openWatch(agentSessionId, { sentAt, baselineActivity });
  await moveToStarted(asked, scope, row.issueId);
  await deps.watchReply(agentSessionId);
}

/**
 * Whether whoever just replied may start this again, having told them why not. It runs on the
 * account of whoever asked, or for a rule the issue's creator, so nobody else's reply can
 * spend that. Someone unlinked who is that person goes on, to be asked to link.
 */
async function mayStartAgain({ installation, agentSessionId, payload, deps }: Context, asked: Context, row: AgentRow | null): Promise<boolean> {
  const say = (body: string) => deps.say(installation.id, agentSessionId, { type: "response", body });
  const speaker = text(payload.agentActivity?.userId);
  if (!speaker) {
    await say(REPLIES.linkThenSay);
    return false;
  }
  const delegator = text(asked.payload.agentSession?.creatorId) ?? text(asked.payload.agentSession?.creator?.id);
  const issueId = issueIdOf(asked.payload);
  const runsAs = delegator && delegator !== installation.appUserId ? delegator : issueId ? ((await deps.creator(installation.id, issueId))?.id ?? null) : null;
  if (speaker === runsAs) return true;
  const owner = await deps.linkedOwner(installation.id, speaker);
  if (!owner) {
    await say(REPLIES.linkThenSay);
    return false;
  }
  if (row?.ownerId === owner) return true;
  await say(REPLIES.notYoursToRestart);
  return false;
}

/** The answer to which repository: only from whoever it would run as. */
async function answerRepo(context: Context, asked: Context, row: AgentRow, reply: string | null): Promise<boolean> {
  const { installation, agentSessionId, payload, deps } = context;
  const say = (content: LinearActivity) => deps.say(installation.id, agentSessionId, content);
  const scope = await teamScope(asked);
  const actor = row.ownerId && row.orgId ? await deps.triageActor(row.ownerId, row.orgId) : null;
  if (!scope || !actor || scope.orgId !== row.orgId) {
    await say({ type: "response", body: REPLIES.notConnected });
    return false;
  }
  const speaker = text(payload.agentActivity?.userId);
  const speakerOwner = speaker ? await deps.linkedOwner(installation.id, speaker) : null;
  if (speakerOwner !== row.ownerId) {
    await say({ type: "response", body: REPLIES.notYours });
    return false;
  }
  // It may be a day later: what was asked may be over. Only if it's closed since: someone may
  // well ask about an issue that's closed.
  if (row.openWhenAsked && (await deps.standing(installation.id, row.issueId).catch(() => null))?.open === false) {
    await deps.stopRow(agentSessionId);
    await say({ type: "response", body: REPLIES.closedSince });
    return false;
  }
  const readable = (await deps.projects(scope.orgId)).filter((p) => actor.levels.has(p.id));
  const chosen = repoFromReply(reply, readable);
  if (!chosen) {
    await askRepo(context, readable, REPLIES.notARepo);
    return false;
  }
  const item = await deps.item(scope.orgId, `${SOURCE}:${row.issueId}`);
  return startSession(asked, scope, { actor, ruleStarted: row.ruleStarted, externalId: speaker, slotTaken: row.slotTaken }, item, chosen, row.prompt ?? firstPrompt(asked.payload), row);
}
