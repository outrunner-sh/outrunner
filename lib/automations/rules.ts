/**
 * What an automation is, and what may be saved as one: the checks the
 * Automations routes run on what the page sends.
 */

import {
  MIN_INTERVAL_MINUTES,
  parseSchedule,
  runTooOften,
  type Schedule,
  SCHEDULES_MAX,
} from "@/lib/automations/schedule";
import { isUuid } from "@/lib/ids";
import { type Effort, effortsFor, isEffort, type ModelProvider, requestedModel } from "@/lib/runtime/session-models";

export const AUTOMATION_TRIGGERS = [
  "pull_request.opened",
  "pull_request.synchronize",
  "pull_request.closed",
  "pull_request.merged",
  "pull_request.review_requested",
  "issues.opened",
  "issues.labeled",
  "schedule",
  "webhook",
  // A Mission's only (target "mission"): a watched Slack channel's message,
  // and a Linear issue routed to it.
  "slack.message",
  "linear.issue",
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

/** A pull request's triggers. */
export type PullRequestTrigger = Extract<AutomationTrigger, `pull_request.${string}`>;

/** An issue's triggers. */
export type IssueTrigger = Extract<AutomationTrigger, `issues.${string}`>;

/** The triggers a Mission's automation may have; the last two are a
 *  Mission's only. */
export const MISSION_TRIGGERS = ["schedule", "webhook", "slack.message", "linear.issue"] as const satisfies readonly AutomationTrigger[];
export const MISSION_ONLY_TRIGGERS: readonly AutomationTrigger[] = ["slack.message", "linear.issue"];

/** Where an automation's runs go: a new session each, or a Mission, as a
 *  request (docs/missions.md, "Triggers"). */
export type TargetKind = "session" | "mission";

/** The longest filter prompt a watched channel has. */
export const FILTER_PROMPT_MAX = 2000;
/** App ids a watched channel hears, at most. */
export const APP_IDS_MAX = 20;

/** The triggers a GitHub event is, which the Outrunner GitHub App's webhook
 *  starts; the rest are Outrunner's own. */
export const GITHUB_TRIGGERS = AUTOMATION_TRIGGERS.filter((t) => t.startsWith("pull_request.") || t.startsWith("issues."));

/** Each trigger as the page names it. */
export const TRIGGER_LABELS: Record<AutomationTrigger, string> = {
  "pull_request.opened": "PR opened",
  "pull_request.synchronize": "New commits on a PR",
  "pull_request.closed": "PR closed without merging",
  "pull_request.merged": "PR merged",
  "pull_request.review_requested": "Review requested on a PR",
  "issues.opened": "Issue opened",
  "issues.labeled": "Issue labeled",
  schedule: "Schedule",
  webhook: "Webhook",
  "slack.message": "Message in a watched Slack channel",
  "linear.issue": "Linear issue delegated to Outrunner",
};

/** What a run list is filtered by: a trigger's kind. A run from before runs
 *  kept their trigger is a pull request's. */
export const TRIGGER_KINDS = ["pull_request", "issues", "schedule", "webhook", "slack", "linear"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const TRIGGER_KIND_LABELS: Record<TriggerKind, string> = {
  pull_request: "Pull request",
  issues: "Issue",
  schedule: "Schedule",
  webhook: "Webhook",
  slack: "Slack",
  linear: "Linear",
};

/** How a run stands: waiting out its debounce window, being set up, set up
 *  (its prompt sent; a Mission's: its request made), its session failed (a
 *  Mission's: its filter failed, to run again), none made (`reason` says
 *  why), or, a Mission's, nothing to do (its filter didn't match, the
 *  Mission is paused). */
export type RunStatus = "queued" | "started" | "ready" | "failed" | "refused" | "skipped";

export function triggerKind(trigger: AutomationTrigger | null): TriggerKind {
  return trigger === null ? "pull_request" : (trigger.split(".")[0] as TriggerKind);
}

export const NAME_MAX = 80;
/** Reviewers or labels an automation names: enough for any one team. */
export const FILTERS_MAX = 20;
export const MAX_RUNS_MAX = 10_000;
/** The longest debounce window: an hour. */
export const DEBOUNCE_MAX_SECONDS = 3600;

/** A run's session: a new one each time, or the automation's last on the
 *  repository, given the next run's prompt. */
export const SESSION_MODES = ["new", "reuse"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];
export const PROMPT_MAX = 20_000;
/** Enough for any one workflow; a list past it is a mistake. One that covers
 *  new repositories isn't held to it: it grows with the org. */
export const REPOS_MAX = 50;

/** Whether an automation can cover new repositories with these triggers:
 *  GitHub's alone, each run on its event's repository. A schedule or a
 *  webhook runs on all of them, which an ever-growing list mustn't fan out
 *  to (automations_cover_new_repos_check). */
export function canCoverNewRepos(triggers: readonly AutomationTrigger[]): boolean {
  return triggers.every((t) => (GITHUB_TRIGGERS as readonly AutomationTrigger[]).includes(t));
}

export const COVER_NEW_REPOS_TRIGGERS_ERROR = "An automation that adds new repositories runs on GitHub events only: untick Schedule and Webhook, or Add new repositories.";

/** What an automation's runs start on, as a session's request names it: a
 *  provider, its model, and the effort picked with it (null, the model's
 *  own). An automation with none runs as the org set its automations to. */
export type AutomationModel = { provider: ModelProvider; id: string; effort: Effort | null };

/** A repository an automation can run on: one of the org's projects. */
export type AutomationRepo = { projectId: string; fullName: string };

export type Automation = {
  id: string;
  name: string;
  template: string | null;
  prompt: string;
  triggers: AutomationTrigger[];
  /** When it runs on its own: with the "schedule" trigger, one or more. */
  schedules: Schedule[];
  repos: AutomationRepo[];
  enabled: boolean;
  /** Whose review requests start it: logins, or `org/team` teams. */
  reviewers: string[];
  /** Which labels on an issue start it; none is any. */
  labels: string[];
  /** How many times it runs before it switches itself off; null, every time. */
  maxRuns: number | null;
  /** Archived too, once it has run its count. */
  archiveWhenDone: boolean;
  /** How long it waits for another trigger on the same thing, to run once
   *  for them all; 0, no wait. */
  debounceSeconds: number;
  sessionMode: SessionMode;
  /** Each GitHub repository connected to the org from now on joins its
   *  repositories (cover_new_project). */
  coverNewRepos: boolean;
  /** Its own model; null, the org's choice for its automations. */
  model: AutomationModel | null;
  /** Done: archived, and off. */
  archived: boolean;
  /** The times it has run against its limit; null with none. */
  runsUsed: number | null;
  /** Who it runs as: whoever last set what it does (its prompt, triggers
   *  or repositories). Null once they've left. */
  runsAs: { id: string; login: string } | null;
  /** Where its runs go (docs/missions.md, "Triggers"). */
  target: AutomationTarget;
  createdAt: string;
};

/** A Mission automation's own settings. */
export type MissionInputs = {
  /** A watched Slack channel, and what a message must be to go to the
   *  Mission (`slack.message`). */
  watch: { teamId: string; channelId: string; filterPrompt: string; allowedAppIds: string[] } | null;
  /** Linear teams whose delegated issues go to it (`linear.issue`), with
   *  the automation's labels as a filter. */
  linearTeamIds: string[];
};

export type AutomationTarget =
  | { kind: "session" }
  | ({ kind: "mission"; missionId: string; missionTitle?: string | null; approved?: boolean; hasHmacSecret?: boolean } & MissionInputs);

/** What's saved: everything the page sets. */
export type AutomationInput = {
  name: string;
  template: string | null;
  prompt: string;
  triggers: AutomationTrigger[];
  schedules: Schedule[];
  projectIds: string[];
  enabled: boolean;
  reviewers: string[];
  labels: string[];
  maxRuns: number | null;
  archiveWhenDone: boolean;
  debounceSeconds: number;
  sessionMode: SessionMode;
  coverNewRepos: boolean;
  model: AutomationModel | null;
  /** A change only: archive it (done), or bring it back. */
  archived?: boolean;
  /** Where its runs go; a session's when not sent. */
  target?: { kind: "session" } | ({ kind: "mission"; missionId: string } & MissionInputs);
  /** A webhook's HMAC secret: set (a string), cleared (null), or kept. */
  webhookSecret?: string | null;
};

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function isTrigger(value: unknown): value is AutomationTrigger {
  return (AUTOMATION_TRIGGERS as readonly unknown[]).includes(value);
}

/**
 * The fields of `body` that are present, checked: a PATCH sends some, a POST
 * all (`full`). Names and prompts are trimmed; triggers and repositories
 * deduplicated. Schedules go with the "schedule" trigger: it needs one, and
 * triggers sent without it clear them. `now` (ms) is when they're checked
 * from.
 */
export function parseAutomationInput(body: unknown, opts: { full: true; now?: number }): Parsed<AutomationInput>;
export function parseAutomationInput(body: unknown, opts: { full: false; now?: number }): Parsed<Partial<AutomationInput>>;
export function parseAutomationInput(
  body: unknown,
  { full, now = Date.now() }: { full: boolean; now?: number },
): Parsed<Partial<AutomationInput>> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the automation as JSON." };
  const b = body as Record<string, unknown>;
  const value: Partial<AutomationInput> = {};

  if (full || b.name !== undefined) {
    const name = typeof b.name === "string" ? b.name.trim().replace(/\s+/g, " ") : "";
    if (name.length < 1 || name.length > NAME_MAX) {
      return { ok: false, error: `Give it a name of 1 to ${NAME_MAX} characters.` };
    }
    value.name = name;
  }
  if (full || b.template !== undefined) {
    if (b.template !== undefined && b.template !== null && typeof b.template !== "string") {
      return { ok: false, error: "That isn't a template." };
    }
    value.template = typeof b.template === "string" && b.template !== "" ? b.template : null;
  }
  if (full || b.prompt !== undefined) {
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    if (prompt.length < 1) return { ok: false, error: "Write the prompt the session runs." };
    if (prompt.length > PROMPT_MAX) return { ok: false, error: `Keep the prompt under ${PROMPT_MAX} characters.` };
    value.prompt = prompt;
  }
  if (full || b.triggers !== undefined) {
    if (!Array.isArray(b.triggers) || !b.triggers.every(isTrigger) || b.triggers.length === 0) {
      return { ok: false, error: "Pick at least one trigger." };
    }
    value.triggers = AUTOMATION_TRIGGERS.filter((t) => (b.triggers as unknown[]).includes(t));
  }
  if (full || b.schedules !== undefined) {
    const sent = b.schedules ?? [];
    if (!Array.isArray(sent)) return { ok: false, error: "Those aren't schedules." };
    if (sent.length > SCHEDULES_MAX) return { ok: false, error: `Add at most ${SCHEDULES_MAX} schedules.` };
    const schedules: Schedule[] = [];
    for (const item of sent) {
      const parsed = parseSchedule(item, now);
      if (!parsed.ok) return parsed;
      schedules.push(parsed.value);
    }
    if (runTooOften(schedules, now)) {
      return { ok: false, error: `Together, its schedules run at most every ${MIN_INTERVAL_MINUTES} minutes.` };
    }
    value.schedules = schedules;
  }
  if (full || b.reviewers !== undefined) {
    const reviewers = names(b.reviewers, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]{1,100})?$/);
    if (!reviewers) return { ok: false, error: `Name reviewers as GitHub logins or org/team, at most ${FILTERS_MAX}.` };
    value.reviewers = reviewers;
  }
  if (full || b.labels !== undefined) {
    const labels = names(b.labels, /^[^\u0000-\u001f]{1,50}$/);
    if (!labels) return { ok: false, error: `Name at most ${FILTERS_MAX} labels, each up to 50 characters.` };
    value.labels = labels;
  }
  if (full || b.maxRuns !== undefined) {
    const max = b.maxRuns ?? null;
    if (max !== null && (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAX_RUNS_MAX)) {
      return { ok: false, error: `Run it from 1 to ${MAX_RUNS_MAX} times, or every time.` };
    }
    value.maxRuns = max as number | null;
  }
  if (full || b.archiveWhenDone !== undefined) {
    if (b.archiveWhenDone !== undefined && typeof b.archiveWhenDone !== "boolean") {
      return { ok: false, error: "Archive when done is on or off." };
    }
    value.archiveWhenDone = b.archiveWhenDone ?? false;
  }
  if (full || b.debounceSeconds !== undefined) {
    const wait = b.debounceSeconds ?? 0;
    if (typeof wait !== "number" || !Number.isInteger(wait) || wait < 0 || wait > DEBOUNCE_MAX_SECONDS) {
      return { ok: false, error: "Combine triggers within an hour at most." };
    }
    value.debounceSeconds = wait;
  }
  if (full || b.sessionMode !== undefined) {
    const mode = b.sessionMode ?? "new";
    if (!(SESSION_MODES as readonly unknown[]).includes(mode)) return { ok: false, error: "A run's session is a new one, or reused." };
    value.sessionMode = mode as SessionMode;
  }
  if (full || b.coverNewRepos !== undefined) {
    if (b.coverNewRepos !== undefined && typeof b.coverNewRepos !== "boolean") {
      return { ok: false, error: "Add new repositories is on or off." };
    }
    value.coverNewRepos = b.coverNewRepos ?? false;
  }
  // Checked here when both are sent; a change of one alone, against what's
  // saved, by the database's check.
  if (value.coverNewRepos && value.triggers && !canCoverNewRepos(value.triggers)) {
    return { ok: false, error: COVER_NEW_REPOS_TRIGGERS_ERROR };
  }
  if (full || b.model !== undefined) {
    const model = parseModel(b.model);
    if (typeof model === "string") return { ok: false, error: model };
    value.model = model;
  }
  if (!full && b.archived !== undefined) {
    if (typeof b.archived !== "boolean") return { ok: false, error: "Archived is on or off." };
    value.archived = b.archived;
  }
  if (value.triggers?.includes("pull_request.review_requested") && value.reviewers?.length === 0) {
    return { ok: false, error: "Name whose review requests start it, or untick Review requested." };
  }
  if (value.triggers) {
    const scheduled = value.triggers.includes("schedule");
    if (scheduled && value.schedules?.length === 0) return { ok: false, error: "Add a schedule, or untick Schedule." };
    // With the trigger off, none are kept that would never fire.
    if (!scheduled) value.schedules = [];
  }
  if (full || b.projectIds !== undefined) {
    if (!Array.isArray(b.projectIds) || !b.projectIds.every((id) => typeof id === "string" && isUuid(id))) {
      return { ok: false, error: "Those aren't repositories of this org." };
    }
    const ids = [...new Set(b.projectIds as string[])];
    // One that covers new repositories (sent with them) may start with none,
    // and grows past the cap.
    if (ids.length === 0 && !value.coverNewRepos) return { ok: false, error: "Pick at least one repository." };
    if (ids.length > REPOS_MAX && !value.coverNewRepos) return { ok: false, error: `Pick at most ${REPOS_MAX} repositories.` };
    value.projectIds = ids;
  }
  if (b.target !== undefined) {
    const target = parseTarget(b.target);
    if (!target.ok) return target;
    value.target = target.value;
  }
  if (b.webhookSecret !== undefined) {
    const secret = b.webhookSecret;
    if (secret !== null && (typeof secret !== "string" || secret.length < 16 || secret.length > 200)) {
      return { ok: false, error: "A webhook signing secret is 16 to 200 characters." };
    }
    value.webhookSecret = secret as string | null;
  }
  if (value.target || value.triggers) {
    const kind = value.target?.kind;
    const triggers = value.triggers ?? [];
    if (kind === "mission" && triggers.some((t) => !(MISSION_TRIGGERS as readonly string[]).includes(t))) {
      return { ok: false, error: "A Mission's automation runs on a schedule, a webhook, a watched Slack channel or Linear issues." };
    }
    if (kind !== "mission" && value.target && triggers.some((t) => MISSION_ONLY_TRIGGERS.includes(t))) {
      return { ok: false, error: "Watched Slack channels and Linear issues go to a Mission: pick one as its destination." };
    }
    if (value.target?.kind === "mission") {
      if (triggers.includes("slack.message") && !value.target.watch) return { ok: false, error: "Pick the Slack channel to watch, and its filter." };
      if (triggers.includes("linear.issue") && value.target.linearTeamIds.length === 0) return { ok: false, error: "Pick the Linear teams whose issues go to the Mission." };
    }
  }
  if (full || b.enabled !== undefined) {
    if (b.enabled !== undefined && typeof b.enabled !== "boolean") return { ok: false, error: "Enabled is on or off." };
    value.enabled = b.enabled ?? true;
  }
  return { ok: true, value };
}

/**
 * An automation's model as it's sent: `{ provider, id, effort }`, the
 * provider and effort optional (as a session's request takes them: no
 * provider is Claude's for its aliases, else Outrunner's). Null or absent
 * clears it. Checked as a session's choice is (modelChoice); whether it's
 * on the runner's menu is the run's to find out. An effort is one of the
 * model's, where those are known: Codex's depend on the account.
 */
export function parseModel(value: unknown): AutomationModel | null | string {
  if (value === undefined || value === null) return null;
  const error = "`model` is `{ provider, id, effort }`, a model from GET /api/v1/models.";
  if (typeof value !== "object" || Array.isArray(value)) return error;
  const m = value as Record<string, unknown>;
  const id = typeof m.id === "string" ? m.id.trim() : m.id;
  const provider = m.provider === null || m.provider === "" ? undefined : m.provider;
  if (typeof id !== "string" || !id) return error;
  const choice = requestedModel({ provider, model: id });
  if (!choice) return "That model isn't one a session can run: pick one from GET /api/v1/models.";
  const effort = m.effort === undefined || m.effort === null || m.effort === "" ? null : m.effort;
  if (effort !== null && !isEffort(effort)) return "An effort is low, medium, high, xhigh or max.";
  if (effort !== null && choice.provider !== "codex" && !effortsFor(choice).includes(effort)) {
    return "That model doesn't take an effort of its own: leave it out.";
  }
  return { provider: choice.provider, id: choice.id, effort };
}

/** A list of names, each matching `pattern`, trimmed and deduplicated (case
 *  aside); null when it isn't one, or is too long. */
function names(value: unknown, pattern: RegExp): string[] | null {
  const list = value ?? [];
  if (!Array.isArray(list) || list.length > FILTERS_MAX) return null;
  const seen = new Map<string, string>();
  for (const item of list) {
    if (typeof item !== "string") return null;
    const name = item.trim().replace(/^@/, "");
    if (!pattern.test(name)) return null;
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()];
}

/** Whether the Outrunner GitHub App can act on a repository, so an
 *  automation on it can post: "unknown" when GitHub couldn't be asked. */
export type AppCoverage = "installed" | "not_installed" | "suspended" | "unknown";

/**
 * The app's coverage of each repository (`owner/name`), from the org's
 * installations: an installation on all of an account's repositories covers
 * every repository that account owns; one on selected repositories covers
 * those listed (`selected`, keyed by installation id; missing when the list
 * couldn't be read, and not `complete` when GitHub had more than was read:
 * then a repository missing from it is "unknown", not "not_installed").
 */
export function appCoverage(
  fullNames: readonly string[],
  installations: readonly {
    installationId: number;
    accountLogin: string;
    repositorySelection: "all" | "selected";
    suspendedAt: string | null;
  }[],
  selected: ReadonlyMap<number, { names: ReadonlySet<string>; complete: boolean }>,
): Map<string, AppCoverage> {
  const result = new Map<string, AppCoverage>();
  for (const fullName of fullNames) {
    const owner = fullName.split("/")[0]?.toLowerCase();
    let coverage: AppCoverage = "not_installed";
    for (const installation of installations) {
      if (installation.accountLogin.toLowerCase() !== owner) continue;
      let covers: boolean | null;
      if (installation.repositorySelection === "all") covers = true;
      else {
        const listed = selected.get(installation.installationId);
        covers = !listed ? null : listed.names.has(fullName.toLowerCase()) ? true : listed.complete ? false : null;
      }
      if (covers === true) {
        coverage = installation.suspendedAt ? "suspended" : "installed";
        if (coverage === "installed") break;
      } else if (covers === null && coverage === "not_installed") {
        coverage = "unknown";
      }
    }
    result.set(fullName, coverage);
  }
  return result;
}

/** Where an automation's runs go, as the page sends it: a session (the
 *  default), or a Mission with its inputs. */
function parseTarget(sent: unknown): Parsed<NonNullable<AutomationInput["target"]>> {
  if (sent === undefined || sent === null) return { ok: true, value: { kind: "session" } };
  if (typeof sent !== "object") return { ok: false, error: "That isn't a destination." };
  const t = sent as Record<string, unknown>;
  if (t.kind === "session") return { ok: true, value: { kind: "session" } };
  if (t.kind !== "mission" || typeof t.missionId !== "string" || !isUuid(t.missionId)) {
    return { ok: false, error: "Pick the Mission its runs go to." };
  }
  let watch: MissionInputs["watch"] = null;
  if (t.watch !== undefined && t.watch !== null) {
    const w = t.watch as Record<string, unknown>;
    const teamId = typeof w.teamId === "string" ? w.teamId.trim() : "";
    const channelId = typeof w.channelId === "string" ? w.channelId.trim() : "";
    const filterPrompt = typeof w.filterPrompt === "string" ? w.filterPrompt.trim() : "";
    if (!/^[A-Z0-9]{2,32}$/.test(teamId) || !/^[CG][A-Z0-9]{2,32}$/.test(channelId)) return { ok: false, error: "Pick a Slack channel to watch." };
    if (filterPrompt.length < 1 || filterPrompt.length > FILTER_PROMPT_MAX) {
      return { ok: false, error: `Write the filter a message must pass, up to ${FILTER_PROMPT_MAX} characters.` };
    }
    const apps = w.allowedAppIds ?? [];
    if (!Array.isArray(apps) || apps.length > APP_IDS_MAX || !apps.every((a) => typeof a === "string" && /^A[A-Z0-9]{2,32}$/.test(a))) {
      return { ok: false, error: `Name at most ${APP_IDS_MAX} Slack app ids (A…) whose messages it hears.` };
    }
    watch = { teamId, channelId, filterPrompt, allowedAppIds: [...new Set(apps as string[])] };
  }
  const teams = t.linearTeamIds ?? [];
  if (!Array.isArray(teams) || teams.length > FILTERS_MAX || !teams.every((x) => typeof x === "string" && /^[A-Za-z0-9-]{1,64}$/.test(x))) {
    return { ok: false, error: `Name at most ${FILTERS_MAX} Linear teams.` };
  }
  return { ok: true, value: { kind: "mission", missionId: t.missionId, watch, linearTeamIds: [...new Set(teams as string[])] } };
}
