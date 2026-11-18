import assert from "node:assert/strict";
import { test } from "node:test";

import { missionIcon } from "@/lib/missions/icons";
import { missionName } from "@/lib/missions/rules";
import {
  assigneeLabel,
  briefSummary,
  missionStatus,
  runnerGroup,
  type RunnerPullView,
  SHIPPING_MS,
} from "@/lib/missions/view";

const NOW = Date.parse("2026-11-02T12:00:00Z");

function pr(patch: Partial<RunnerPullView> = {}): RunnerPullView {
  return {
    repo: "acme/app",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    title: "Fix login",
    state: "open",
    verdict: null,
    reason: null,
    additions: 10,
    deletions: 2,
    checks: [],
    reviewState: "none",
    mergeableState: "blocked",
    endedAt: null,
    ...patch,
  };
}

const group = (state: Parameters<typeof runnerGroup>[0]["state"], pulls: RunnerPullView[], extra: { lostCause?: string; errorMessage?: string } = {}) =>
  runnerGroup({ state, pulls, lostCause: extra.lostCause ?? null, errorMessage: extra.errorMessage ?? null }, NOW);

test("a Runner's group follows what it waits on", () => {
  assert.deepEqual(group("working", []), { group: "working", attention: null });
  assert.deepEqual(group("idle", [pr()]), { group: "working", attention: null });
  assert.deepEqual(group("idle", [pr({ verdict: "ready" })]), { group: "ready_to_review", attention: null });
  assert.deepEqual(group("idle", [pr({ verdict: "ready", reviewState: "approved", mergeableState: "clean" })]), {
    group: "ready_to_merge",
    attention: null,
  });
  assert.deepEqual(group("idle", [pr({ verdict: "needs_attention", reason: "it has merge conflicts" })]), {
    group: "needs_you",
    attention: "it has merge conflicts",
  });
  assert.deepEqual(group("failed", [], { errorMessage: "no box" }), { group: "needs_you", attention: "no box" });
  assert.deepEqual(group("idle", [], { lostCause: "its agent exited" }), { group: "needs_you", attention: "its agent exited" });
});

test("one of two pull requests ready isn't the Runner ready", () => {
  assert.equal(group("idle", [pr({ verdict: "ready" }), pr({ number: 8 })]).group, "working");
});

test("an archived Runner: shipping while its merge is fresh, then done; its open pull request keeps it in view", () => {
  const merged = (ago: number) => pr({ state: "merged", endedAt: new Date(NOW - ago).toISOString() });
  assert.equal(group("archived", [merged(60_000)]).group, "shipping");
  assert.equal(group("archived", [merged(SHIPPING_MS + 1)]).group, "done");
  assert.equal(group("archived", []).group, "done");
  assert.equal(group("archived", [pr({ verdict: "ready" })]).group, "ready_to_review");
});

const standing = (s: "needs_you" | "working" | "in_review" | "done") => ({ standing: s });

test("a Mission needs you only when its own session does; then working, ready, idle", () => {
  const idle = { group: "working" as const, state: "idle" as const, pulls: [] };
  assert.equal(missionStatus({ standing: standing("needs_you"), runners: [] }), "needs_you");
  assert.equal(missionStatus({ standing: standing("working"), runners: [] }), "working");
  assert.equal(missionStatus({ standing: standing("done"), runners: [{ ...idle, state: "working" }] }), "working");
  // A pull request settling is work still going.
  assert.equal(missionStatus({ standing: standing("done"), runners: [{ ...idle, pulls: [pr()] }] }), "working");
  assert.equal(missionStatus({ standing: standing("done"), runners: [{ ...idle, group: "ready_to_review", pulls: [pr({ verdict: "ready" })] }] }), "ready");
  // A stuck Runner is the Mission's to handle, not the user's.
  assert.equal(missionStatus({ standing: standing("done"), runners: [{ ...idle, group: "needs_you" }] }), "idle");
  assert.equal(missionStatus({ standing: null, runners: [] }), "idle");
});

test("a Runner that needs a person as any session would is in Needs you, saying why", () => {
  assert.deepEqual(
    runnerGroup({ state: "working", pulls: [], lostCause: null, errorMessage: null, standing: { standing: "needs_you", reason: "question" } }),
    { group: "needs_you", attention: "Asked you a question" },
  );
  assert.equal(
    runnerGroup({ state: "working", pulls: [], lostCause: null, errorMessage: null, standing: { standing: "working", reason: null } }).group,
    "working",
  );
});

test("a brief's line: plan mode and markup left off", () => {
  assert.equal(briefSummary("Plan mode: read first.\n\n## Fix the login redirect\nDetails"), "Fix the login redirect");
  assert.equal(briefSummary("1. Add the file"), "Add the file");
  assert.equal(briefSummary(null), "");
  assert.equal(briefSummary("x".repeat(200)).length, 140);
});

test("a Mission's icon: the one picked, else one from its id, the same each time", () => {
  assert.equal(missionIcon("m1", "rocket").key, "rocket");
  assert.equal(missionIcon("m1", null).key, missionIcon("m1", null).key);
  assert.equal(missionIcon("m1", "nonsense").key, missionIcon("m1", null).key);
});

test("a Mission is named from its first sentence, short", () => {
  assert.equal(missionName("Own billing. Keep invoices right."), "Own billing");
  assert.equal(
    missionName("Own the end-to-end test docs under e2e/missions/ in outrunner-sh/outrunner. Start two Runners now."),
    "Own the end-to-end test docs under…",
  );
  assert.equal(missionName("**Onboarding**: first session under a minute"), "Onboarding");
  assert.equal(missionName("   "), "New Mission");
  // A heading-style first line is the name it was given.
  assert.equal(missionName("Billing\nOwn invoices and keep Stripe in step. Then more."), "Billing");
  assert.equal(missionName("\n\n## Onboarding\nFirst session under a minute"), "Onboarding");
});

test("the Ships pane names an assignee by login, real name, else email: never the \"Someone\" placeholder", () => {
  const NO = "Someone";
  const people = new Map([
    ["u-gh", { login: "wes", name: "Wes", email: "w@x.dev" }],
    ["u-named", { login: "", name: "Ana Lima", email: "ana@x.dev" }],
    // An email-only account (the kind `!assign` picks from Slack): personFrom names it the placeholder.
    ["u-email", { login: "", name: NO, email: "liverun-a@example.com" }],
  ]);
  assert.equal(assigneeLabel("u-gh", people, NO), "wes");
  assert.equal(assigneeLabel("u-named", people, NO), "Ana Lima");
  assert.equal(assigneeLabel("u-email", people, NO), "liverun-a@example.com");
  // No assignee, or one that couldn't be looked up: no label, as before.
  assert.equal(assigneeLabel(null, people, NO), null);
  assert.equal(assigneeLabel("u-gone", people, NO), null);
});
