import assert from "node:assert/strict";
import { test } from "node:test";

import { blockedTarget, defaultStateMap, doneTarget, firstMatch, matchesRule, parseRuleInput, parseScopeSettings, type RuleFilters, startedTarget, stateMapOf, UNASSIGNED } from "@/lib/trackers/rules";

const none: RuleFilters = { labels: [], states: [], priorities: [], issueTypes: [], assignees: [] };
const issue = { labels: ["bug", "ui"], state: "todo", priority: "2", issueType: null, assignee: null };

test("an empty filter means any", () => {
  assert.equal(matchesRule(none, issue), true);
});

test("OR within a field", () => {
  assert.equal(matchesRule({ ...none, labels: ["api", "ui"] }, issue), true);
  assert.equal(matchesRule({ ...none, labels: ["api"] }, issue), false);
});

test("AND across fields", () => {
  assert.equal(matchesRule({ ...none, labels: ["bug"], priorities: ["2"] }, issue), true);
  assert.equal(matchesRule({ ...none, labels: ["bug"], priorities: ["1"] }, issue), false);
  assert.equal(matchesRule({ ...none, labels: ["bug"], states: ["done"] }, issue), false);
});

test("the assignee filter knows unassigned, and an assignee by id", () => {
  assert.equal(matchesRule({ ...none, assignees: [UNASSIGNED] }, issue), true);
  assert.equal(matchesRule({ ...none, assignees: ["ana"] }, issue), false);
  assert.equal(matchesRule({ ...none, assignees: ["ana"] }, { ...issue, assignee: "ana" }), true);
  assert.equal(matchesRule({ ...none, assignees: [UNASSIGNED] }, { ...issue, assignee: "ana" }), false);
});

test("a filter on a value the issue doesn't have doesn't match", () => {
  assert.equal(matchesRule({ ...none, issueTypes: ["bug"] }, issue), false);
  assert.equal(matchesRule({ ...none, priorities: ["1"] }, { ...issue, priority: null }), false);
});

test("the first enabled match by position wins", () => {
  const rule = (id: string, position: number, enabled = true, labels: string[] = []) => ({ ...none, id, position, enabled, labels });
  assert.equal(firstMatch([rule("b", 2), rule("a", 1)], issue)?.id, "a");
  assert.equal(firstMatch([rule("a", 1, false), rule("b", 2)], issue)?.id, "b");
  assert.equal(firstMatch([rule("a", 1, true, ["api"]), rule("b", 2, true, ["ui"])], issue)?.id, "b");
  assert.equal(firstMatch([rule("a", 1, false)], issue), null);
});

test("Linear has no issue types, and only its own priorities", () => {
  assert.equal(parseRuleInput({ issueTypes: ["bug"] }, "linear", { full: true }).ok, false);
  assert.equal(parseRuleInput({ priorities: ["9"] }, "linear", { full: true }).ok, false);
  assert.equal(parseRuleInput({ priorities: ["0", "4"] }, "linear", { full: true }).ok, true);
});

test("Jira keeps issue types and its own priority ids", () => {
  const parsed = parseRuleInput({ issueTypes: ["10001"], priorities: ["10042"] }, "jira", { full: true });
  assert.equal(parsed.ok && parsed.value.issueTypes[0], "10001");
  assert.equal(parsed.ok && parsed.value.priorities[0], "10042");
});

test("each filter is capped, and repeats are dropped", () => {
  const many = Array.from({ length: 21 }, (_, i) => `l${i}`);
  assert.equal(parseRuleInput({ labels: many }, "linear", { full: true }).ok, false);
  const parsed = parseRuleInput({ labels: ["a", "a", "b"] }, "linear", { full: true });
  assert.deepEqual(parsed.ok && parsed.value.labels, ["a", "b"]);
});

test("a rule's project is a project, or Unsorted", () => {
  assert.equal(parseRuleInput({ projectId: "not-a-uuid" }, "linear", { full: true }).ok, false);
  assert.equal(parseRuleInput({ projectId: 7 }, "linear", { full: true }).ok, false);
  const parsed = parseRuleInput({}, "linear", { full: true });
  assert.equal(parsed.ok && parsed.value.projectId, null);
  assert.equal(parsed.ok && parsed.value.enabled, true);
});

test("a change leaves out what it doesn't send", () => {
  const parsed = parseRuleInput({ enabled: false }, "linear", { full: false });
  assert.deepEqual(parsed.ok && parsed.value, { enabled: false });
});

test("the daily cap of rule-started sessions has bounds", () => {
  assert.equal(parseScopeSettings({ ruleSessionsPerDay: 0 }).ok, false);
  assert.equal(parseScopeSettings({ ruleSessionsPerDay: 501 }).ok, false);
  assert.equal(parseScopeSettings({ ruleSessionsPerDay: 1.5 }).ok, false);
  assert.equal(parseScopeSettings({ ruleSessionsPerDay: 20 }).ok, true);
  assert.equal(parseScopeSettings({ acceptRuleSessions: "yes" }).ok, false);
});

test("a team's state map starts on In Progress and In Review", () => {
  const states = [
    { id: "1", name: "Backlog", type: "backlog" },
    { id: "2", name: "In Progress", type: "started" },
    { id: "3", name: "In Review", type: "started" },
    { id: "4", name: "Done", type: "completed" },
  ];
  assert.deepEqual(defaultStateMap(states), { started: "2", inReview: "3", done: "4", blocked: null });
  assert.deepEqual(defaultStateMap([{ id: "9", name: "Doing", type: "started" }]), { started: "9", inReview: null, done: null, blocked: null });
  assert.equal(defaultStateMap([{ id: "1", name: "Backlog", type: "backlog" }]), null);
});

test("Done and Blocked: matched by name, Done by type too, and each can be off", () => {
  const states = [
    { id: "1", name: "Todo", type: "unstarted" },
    { id: "2", name: "In Progress", type: "started" },
    { id: "3", name: "In Review", type: "started" },
    { id: "4", name: "Blocked", type: "started" },
    { id: "5", name: "Shipped", type: "completed" },
    { id: "6", name: "Done", type: "completed" },
  ];
  assert.deepEqual(defaultStateMap(states), { started: "2", inReview: "3", done: "6", blocked: "4" });
  assert.deepEqual(defaultStateMap(states.filter((s) => s.id !== "6" && s.id !== "4")), { started: "2", inReview: "3", done: "5", blocked: null });
  assert.equal(defaultStateMap([{ id: "1", name: "Todo", type: "unstarted" }]), null);
  // A map saved before these, and the page's settings.
  assert.deepEqual(stateMapOf({ started: "2", inReview: "3" }), { started: "2", inReview: "3", done: null, blocked: null });
  assert.equal(stateMapOf(null), null);
  const parsed = parseScopeSettings({ stateMap: { started: "2", inReview: null, done: "6", blocked: "4" } });
  assert.deepEqual(parsed.ok && parsed.value.stateMap, { started: "2", inReview: null, done: "6", blocked: "4" });
  assert.equal(parseScopeSettings({ stateMap: { done: 7 } }).ok, false);
  assert.equal(parseScopeSettings({ stateMap: { blocked: "x".repeat(201) } }).ok, false);
});

test("where an issue moves: started, blocked and done, never over a person's own move", () => {
  const map = { started: "prog", inReview: "rev", done: "done", blocked: "blk" };
  // Started: from not started, or from Blocked; not from where a person put it, nor once closed.
  assert.equal(startedTarget(map, { stateId: "todo", stateType: "unstarted" }), "prog");
  assert.equal(startedTarget(map, { stateId: "back", stateType: "backlog" }), "prog");
  assert.equal(startedTarget(map, { stateId: "blk", stateType: "started" }), "prog");
  assert.equal(startedTarget(map, { stateId: "prog", stateType: "started" }), null);
  assert.equal(startedTarget(map, { stateId: "rev", stateType: "started" }), null);
  assert.equal(startedTarget(map, { stateId: "x", stateType: "completed" }), null);
  assert.equal(startedTarget({ ...map, started: null }, { stateId: "blk", stateType: "started" }), null);
  // Blocked: from anywhere open, but not twice.
  assert.equal(blockedTarget(map, { stateId: "todo", stateType: "unstarted" }), "blk");
  assert.equal(blockedTarget(map, { stateId: "prog", stateType: "started" }), "blk");
  assert.equal(blockedTarget(map, { stateId: "blk", stateType: "started" }), null);
  for (const stateType of ["completed", "canceled", "duplicate"]) assert.equal(blockedTarget(map, { stateId: "x", stateType }), null);
  assert.equal(blockedTarget({ ...map, blocked: null }, { stateId: "prog", stateType: "started" }), null);
  // Done: only from where a session put it.
  assert.equal(doneTarget(map, { stateId: "prog", stateType: "started" }), "done");
  assert.equal(doneTarget(map, { stateId: "rev", stateType: "started" }), "done");
  assert.equal(doneTarget(map, { stateId: "blk", stateType: "started" }), null);
  assert.equal(doneTarget(map, { stateId: "todo", stateType: "unstarted" }), null);
  assert.equal(doneTarget(map, { stateId: null, stateType: "started" }), null);
  assert.equal(doneTarget({ ...map, done: null }, { stateId: "rev", stateType: "started" }), null);
  assert.equal(doneTarget(null, { stateId: "rev", stateType: "started" }), null);
});
