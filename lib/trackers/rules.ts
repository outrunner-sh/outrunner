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
    if (project !== null && (typeof project !== "string" || !isUuid(project))) return { ok: false, error: "That isn't a project." };
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
  /** The tracker's states; null is off. */
  stateMap: { started: string | null; inReview: string | null } | null;
};

/** A connected team's settings as the page sends them; what's left out stays. */
export function parseScopeSettings(body: unknown): Parsed<Partial<ScopeSettings>> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the settings as JSON." };
  const b = body as Record<string, unknown>;
  const value: Partial<ScopeSettings> = {};
  if (b.defaultProjectId !== undefined) {
    if (b.defaultProjectId !== null && (typeof b.defaultProjectId !== "string" || !isUuid(b.defaultProjectId))) {
      return { ok: false, error: "That isn't a project." };
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
      if (typeof map !== "object" || !state(map.started) || !state(map.inReview)) {
        return { ok: false, error: "Those aren't the team's states." };
      }
      value.stateMap = { started: (map.started as string | null) ?? null, inReview: (map.inReview as string | null) ?? null };
    }
  }
  return { ok: true, value };
}

/**
 * The state map a team starts with: its states named In Progress and In Review,
 * the first of each by type when a team renamed them. A team with neither has
 * no map to start with: an admin picks, or leaves it off.
 */
export function defaultStateMap(states: readonly { id: string; name: string; type: string }[]): ScopeSettings["stateMap"] {
  const named = (name: string) => states.find((s) => s.name.toLowerCase() === name);
  const started = named("in progress") ?? states.find((s) => s.type === "started");
  const inReview = named("in review") ?? null;
  return started || inReview ? { started: started?.id ?? null, inReview: inReview?.id ?? null } : null;
}
