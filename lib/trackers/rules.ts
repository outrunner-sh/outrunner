/**
 * What a tracker rule is, the parts with no database: how an issue matches one,
 * and what may be saved as one. lib/db/trackers.ts stores them.
 *
 * Every filter works one way: AND across fields, OR within a field, and an
 * empty field means any. Values are the tracker's ids, never names, which
 * change.
 */

import { FILTERS_MAX } from "@/lib/automations/rules";
import { isUuid } from "@/lib/ids";

export type TrackerProvider = "linear" | "jira";

/** An assignee filter's value for an issue with no assignee. */
export const UNASSIGNED = "unassigned";

/** Linear's priorities, by the number its API gives them. */
export const LINEAR_PRIORITIES: readonly { id: string; label: string }[] = [
  { id: "0", label: "No priority" },
  { id: "1", label: "Urgent" },
  { id: "2", label: "High" },
  { id: "3", label: "Medium" },
  { id: "4", label: "Low" },
];

export type RuleFilters = {
  labels: string[];
  states: string[];
  priorities: string[];
  /** Jira's. Linear has no issue types: its labels (Bug, Feature, Improvement
   *  by default) stand in for them, so it's always empty there. */
  issueTypes: string[];
  assignees: string[];
};

export type TrackerRule = RuleFilters & {
  id: string;
  scopeId: string;
  position: number;
  /** Where it files; null is Unsorted. */
  projectId: string | null;
  setBy: string | null;
  enabled: boolean;
};

/** What a rule is checked against: the issue as it is now. */
export type IssueFacts = {
  labels: readonly string[];
  state: string | null;
  priority: string | null;
  issueType: string | null;
  /** Null: no one. */
  assignee: string | null;
};

/** Linear's closed workflow state types: a duplicate has its own, beside canceled.
 *  A closed issue is never filed. */
export function isClosedStateType(type: unknown): boolean {
  return type === "completed" || type === "canceled" || type === "duplicate";
}

function anyOf(wanted: readonly string[], has: readonly string[]): boolean {
  return wanted.length === 0 || wanted.some((value) => has.includes(value));
}

function one(value: string | null): string[] {
  return value === null ? [] : [value];
}

export function matchesRule(rule: RuleFilters, issue: IssueFacts): boolean {
  return (
    anyOf(rule.labels, issue.labels) &&
    anyOf(rule.states, one(issue.state)) &&
    anyOf(rule.priorities, one(issue.priority)) &&
    anyOf(rule.issueTypes, one(issue.issueType)) &&
    anyOf(rule.assignees, [issue.assignee ?? UNASSIGNED])
  );
}

/** The rule that files an issue: the first enabled match, lowest position first. */
export function firstMatch<R extends RuleFilters & { enabled: boolean; position: number }>(
  rules: readonly R[],
  issue: IssueFacts,
): R | null {
  return [...rules].sort((a, b) => a.position - b.position).find((rule) => rule.enabled && matchesRule(rule, issue)) ?? null;
}

export type RuleInput = RuleFilters & { projectId: string | null; enabled: boolean };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function values(input: unknown): string[] | null {
  const sent = input ?? [];
  if (!Array.isArray(sent) || sent.length > FILTERS_MAX) return null;
  const kept = new Set<string>();
  for (const value of sent) {
    if (typeof value !== "string" || !/^[^\u0000-\u001f]{1,200}$/.test(value)) return null;
    kept.add(value);
  }
  return [...kept];
}

/**
 * A rule as the settings page sends it, checked for the tracker it's on. The
 * fields left out of a change (`full` false) stay as they are.
 */
export function parseRuleInput(body: unknown, provider: TrackerProvider, opts: { full: true }): Parsed<RuleInput>;
export function parseRuleInput(body: unknown, provider: TrackerProvider, opts: { full: false }): Parsed<Partial<RuleInput>>;
export function parseRuleInput(
  body: unknown,
  provider: TrackerProvider,
  { full }: { full: boolean },
): Parsed<Partial<RuleInput>> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the rule as JSON." };
  const b = body as Record<string, unknown>;
  const value: Partial<RuleInput> = {};
  for (const field of ["labels", "states", "priorities", "issueTypes", "assignees"] as const) {
    if (!full && b[field] === undefined) continue;
    const list = values(b[field]);
    if (!list) return { ok: false, error: `Pick at most ${FILTERS_MAX} of each filter.` };
    value[field] = list;
  }
  if (provider === "linear") {
    if (value.issueTypes?.length) return { ok: false, error: "Linear has no issue types: filter on its labels instead." };
    if (value.priorities?.some((p) => !LINEAR_PRIORITIES.some((known) => known.id === p))) {
      return { ok: false, error: "That isn't one of Linear's priorities." };
    }
  }
  if (full || b.projectId !== undefined) {
    const project = b.projectId ?? null;
    if (project !== null && (typeof project !== "string" || !isUuid(project))) return { ok: false, error: "That isn't a repository." };
    value.projectId = project as string | null;
  }
  if (full || b.enabled !== undefined) {
    const enabled = b.enabled ?? true;
    if (typeof enabled !== "boolean") return { ok: false, error: "Enabled is on or off." };
    value.enabled = enabled;
  }
  return { ok: true, value };
}

/** The most sessions a Linear or Jira rule may start in a team in a day. */
export const RULE_SESSIONS_MAX = 500;

export type ScopeSettings = {
  defaultProjectId: string | null;
  acceptRuleSessions: boolean;
  ruleSessionsPerDay: number;
  /** The tracker's states; null is off, for each and for all. */
  stateMap: StateMap | null;
};

/** Where a delegated session moves its issue: when it starts or resumes, while it's blocked
 *  (waiting on someone, or its setup or turn failed), when its PR opens, and when it merges. */
export type StateMap = { started: string | null; inReview: string | null; done: string | null; blocked: string | null };

const STATE_KEYS = ["started", "inReview", "done", "blocked"] as const;

/** A map as stored: one saved before Done and Blocked has neither. */
export function stateMapOf(raw: unknown): StateMap | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === "string" && v ? v : null);
  return { started: id(r.started), inReview: id(r.inReview), done: id(r.done), blocked: id(r.blocked) };
}

/** Where an issue is, as far as moving it goes. */
export type IssueState = { stateId?: string | null; stateType: string | null };

const CLOSED_TYPES = ["completed", "canceled", "duplicate"];

/** Started, from not started yet, or from Blocked: it's being worked on again. Not from where
 *  a person moved it, nor once it's past started. */
export function startedTarget(map: StateMap | null, issue: IssueState): string | null {
  if (!map?.started || issue.stateId === map.started) return null;
  if (map.blocked && issue.stateId === map.blocked) return map.started;
  return ["started", ...CLOSED_TYPES].includes(issue.stateType ?? "") ? null : map.started;
}

/** Blocked, unless it's closed or there already. */
export function blockedTarget(map: StateMap | null, issue: IssueState): string | null {
  if (!map?.blocked || issue.stateId === map.blocked || CLOSED_TYPES.includes(issue.stateType ?? "")) return null;
  return map.blocked;
}

/** Done, when its PR merges: only from the states a session put it in (Blocked too, as a lost
 *  turn after the PR opened leaves it there), so a person's own move since wins. */
export function doneTarget(map: StateMap | null, issue: IssueState): string | null {
  if (!map?.done || !issue.stateId) return null;
  return [map.started, map.inReview, map.blocked].includes(issue.stateId) ? map.done : null;
}

/** A connected team's settings as the page sends them; what's left out stays. */
export function parseScopeSettings(body: unknown): Parsed<Partial<ScopeSettings>> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the settings as JSON." };
  const b = body as Record<string, unknown>;
  const value: Partial<ScopeSettings> = {};
  if (b.defaultProjectId !== undefined) {
    if (b.defaultProjectId !== null && (typeof b.defaultProjectId !== "string" || !isUuid(b.defaultProjectId))) {
      return { ok: false, error: "That isn't a repository." };
    }
    value.defaultProjectId = b.defaultProjectId as string | null;
  }
  if (b.acceptRuleSessions !== undefined) {
    if (typeof b.acceptRuleSessions !== "boolean") return { ok: false, error: "That setting is on or off." };
    value.acceptRuleSessions = b.acceptRuleSessions;
  }
  if (b.ruleSessionsPerDay !== undefined) {
    const cap = b.ruleSessionsPerDay;
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1 || cap > RULE_SESSIONS_MAX) {
      return { ok: false, error: `Allow from 1 to ${RULE_SESSIONS_MAX} sessions a day.` };
    }
    value.ruleSessionsPerDay = cap;
  }
  if (b.stateMap !== undefined) {
    if (b.stateMap === null) {
      value.stateMap = null;
    } else {
      const map = b.stateMap as Record<string, unknown>;
      const state = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.length > 0 && v.length <= 200);
      if (typeof map !== "object" || !STATE_KEYS.every((key) => state(map[key]))) {
        return { ok: false, error: "Those aren't the team's states." };
      }
      value.stateMap = {
        started: (map.started as string | null) ?? null,
        inReview: (map.inReview as string | null) ?? null,
        done: (map.done as string | null) ?? null,
        blocked: (map.blocked as string | null) ?? null,
      };
    }
  }
  return { ok: true, value };
}

/**
 * The state map a team starts with, by name: In Progress (else the first started one),
 * In Review, Done (else the first completed one) and Blocked. A team without one leaves it
 * off, and one with none has no map to start with: an admin picks, or leaves it off.
 */
export function defaultStateMap(states: readonly { id: string; name: string; type: string }[]): ScopeSettings["stateMap"] {
  const named = (name: string) => states.find((s) => s.name.toLowerCase() === name);
  const map: StateMap = {
    started: (named("in progress") ?? states.find((s) => s.type === "started"))?.id ?? null,
    inReview: named("in review")?.id ?? null,
    done: (named("done") ?? states.find((s) => s.type === "completed"))?.id ?? null,
    blocked: named("blocked")?.id ?? null,
  };
  return Object.values(map).some(Boolean) ? map : null;
}
