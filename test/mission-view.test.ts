import assert from "node:assert/strict";
import { test } from "node:test";

import { missionIcon } from "@/lib/missions/icons";
import { missionName } from "@/lib/missions/rules";
import {
  asksUser,
  briefSummary,
  type MissionView,
  missionStatus,
  newsBetween,
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

test("a Mission needs you only when it asks; then working, ready, idle", () => {
  const idle = { group: "working" as const, state: "idle" as const, pulls: [] };
  assert.equal(missionStatus({ asking: true, working: false, runners: [] }), "needs_you");
  assert.equal(missionStatus({ asking: false, working: true, runners: [] }), "working");
  assert.equal(missionStatus({ asking: false, working: false, runners: [{ ...idle, state: "working" }] }), "working");
  // A pull request settling is work still going.
  assert.equal(missionStatus({ asking: false, working: false, runners: [{ ...idle, pulls: [pr()] }] }), "working");
  assert.equal(missionStatus({ asking: false, working: false, runners: [{ ...idle, group: "ready_to_review", pulls: [pr({ verdict: "ready" })] }] }), "ready");
  // A stuck Runner is the Mission's to handle, not the user's.
  assert.equal(missionStatus({ asking: false, working: false, runners: [{ ...idle, group: "needs_you" }] }), "idle");
});

test("a reply that ends on a question asks the user, once the Mission has stopped", () => {
  assert.equal(asksUser("Both are ready.\n\nShould I merge them?", false), true);
  assert.equal(asksUser("Want me to open a PR?**", false), true);
  assert.equal(asksUser("Should I merge them?", true), false);
  assert.equal(asksUser("Delegated to Runner A. Done.", false), false);
  assert.equal(asksUser(null, false), false);
});

test("a brief's line: plan mode and markup left off", () => {
  assert.equal(briefSummary("Plan mode: read first.\n\n## Fix the login redirect\nDetails"), "Fix the login redirect");
  assert.equal(briefSummary("1. Add the file"), "Add the file");
  assert.equal(briefSummary(null), "");
  assert.equal(briefSummary("x".repeat(200)).length, 140);
});

function mission(patch: Partial<MissionView> = {}): MissionView {
  return {
    id: "m1",
    title: "Billing",
    icon: null,
    status: "working",
    readyCount: 0,
    liveRunners: 1,
    environment: null,
    sessionStatus: "ready",
    runners: [{ id: "r1", name: "Fix login", summary: "", state: "idle", branch: "b", pulls: [pr()], group: "working", attention: null, createdAt: "" }],
    createdAt: "",
    ...patch,
  };
}

test("news: a pull request that became ready, and a Mission that came to need you, once each", () => {
  const before = [mission()];
  const ready = [mission({ status: "ready", runners: [{ ...before[0].runners[0], pulls: [pr({ verdict: "ready" })], group: "ready_to_review" }] })];
  assert.deepEqual(
    newsBetween(before, ready).map((n) => [n.kind, n.pr?.number]),
    [["ready", 7]],
  );
  assert.deepEqual(newsBetween(ready, ready), []);
  assert.deepEqual(
    newsBetween(ready, [{ ...ready[0], status: "needs_you" }]).map((n) => n.kind),
    ["needs_you"],
  );
  // The first look is no news.
  assert.deepEqual(newsBetween(null, ready), []);
});

test("a Mission's icon: the one picked, else one from its id, the same each time", () => {
  assert.equal(missionIcon("m1", "rocket").key, "rocket");
  assert.equal(missionIcon("m1", null).key, missionIcon("m1", null).key);
  assert.equal(missionIcon("m1", "nonsense").key, missionIcon("m1", null).key);
});

test("a Mission is named from its first sentence, short", () => {
  assert.equal(missionName("Own billing. Keep invoices right."), "Own billing");
  assert.equal(
    missionName("Own the end-to-end test docs under e2e/missions/ in neevai-labs/outrunner. Start two Runners now."),
    "Own the end-to-end test docs under…",
  );
  assert.equal(missionName("**Onboarding**: first session under a minute"), "Onboarding");
  assert.equal(missionName("   "), "New Mission");
});
