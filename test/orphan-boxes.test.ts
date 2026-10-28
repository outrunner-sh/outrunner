import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boxLabels,
  deploymentName,
  DEPLOYMENT_LABEL,
  type ListedBox,
  ORPHAN_GRACE_MS,
  ORPHAN_SWEEP_MAX,
  orphanedBoxes,
  sweepable,
} from "@/lib/runtime/orphan-boxes";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const HOUR = 60 * 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** A box of Outrunner's, made and last touched three hours ago. */
function box(overrides: Partial<ListedBox> = {}): ListedBox {
  return {
    id: "sb-1",
    labels: { "runtime.role": "computer", "runtime.engine": "claude" },
    state: "started",
    createdAt: ago(3 * HOUR),
    lastActivityAt: ago(3 * HOUR),
    ...overrides,
  };
}

const options = { now: NOW, deployment: "outrunner.example" };

test("a box of Outrunner's no row names, old and quiet, is swept", () => {
  assert.deepEqual(orphanedBoxes([box()], new Set(), options), ["sb-1"]);
  // Stopped (paused) boxes cost their disk: swept too.
  assert.deepEqual(orphanedBoxes([box({ state: "stopped" }), box({ id: "sb-2", state: "error" })], new Set(), options), [
    "sb-1",
    "sb-2",
  ]);
});

test("a box a row names is never swept, whatever its age", () => {
  assert.deepEqual(orphanedBoxes([box({ createdAt: ago(60 * 24 * HOUR) })], new Set(["sb-1"]), options), []);
});

test("only boxes labelled as Outrunner's computers", () => {
  assert.equal(sweepable(box({ labels: {} }), NOW, options.deployment), false);
  assert.equal(sweepable(box({ labels: { "runtime.role": "something-else" } }), NOW, options.deployment), false);
});

test("a box another deployment made is left alone; one from before the label is this one's", () => {
  const theirs = box({ labels: { ...box().labels, [DEPLOYMENT_LABEL]: "staging.example" } });
  const ours = box({ labels: { ...box().labels, [DEPLOYMENT_LABEL]: "outrunner.example" } });
  assert.equal(sweepable(theirs, NOW, options.deployment), false);
  assert.equal(sweepable(ours, NOW, options.deployment), true);
  assert.equal(sweepable(box(), NOW, options.deployment), true);
  // A deployment with no name of its own sweeps only unlabelled boxes.
  assert.equal(sweepable(ours, NOW, null), false);
  assert.equal(sweepable(box(), NOW, null), true);
});

test("a box made or touched within the grace is left: its id may not be recorded yet", () => {
  assert.equal(sweepable(box({ createdAt: ago(ORPHAN_GRACE_MS - 60_000) }), NOW, options.deployment), false);
  assert.equal(sweepable(box({ lastActivityAt: ago(5 * 60_000) }), NOW, options.deployment), false);
  assert.equal(sweepable(box({ createdAt: ago(ORPHAN_GRACE_MS + 60_000), lastActivityAt: ago(ORPHAN_GRACE_MS + 60_000) }), NOW, options.deployment), true);
});

test("a date that can't be read, or a box on its way into or out of a state, says no", () => {
  assert.equal(sweepable(box({ createdAt: undefined }), NOW, options.deployment), false);
  assert.equal(sweepable(box({ lastActivityAt: undefined }), NOW, options.deployment), false);
  assert.equal(sweepable(box({ lastActivityAt: "yesterday" }), NOW, options.deployment), false);
  for (const state of ["creating", "starting", "restoring", "stopping", "archiving", "destroying", "destroyed"]) {
    assert.equal(sweepable(box({ state }), NOW, options.deployment), false, state);
  }
});

test("at most a run's worth, the longest quiet first", () => {
  const boxes = Array.from({ length: ORPHAN_SWEEP_MAX + 5 }, (_, i) =>
    box({ id: `sb-${i}`, lastActivityAt: ago((3 + i) * HOUR) }),
  );
  const swept = orphanedBoxes(boxes, new Set(), options);
  assert.equal(swept.length, ORPHAN_SWEEP_MAX);
  assert.equal(swept[0], `sb-${ORPHAN_SWEEP_MAX + 4}`);
  assert.deepEqual(orphanedBoxes(boxes, new Set(), { ...options, max: 2 }), [`sb-${ORPHAN_SWEEP_MAX + 4}`, `sb-${ORPHAN_SWEEP_MAX + 3}`]);
});

test("boxes are made with their role, engine and deployment", () => {
  assert.equal(deploymentName("https://outrunner.example/"), "outrunner.example");
  assert.equal(deploymentName(undefined), null);
  assert.equal(deploymentName("not a url"), null);
  assert.deepEqual(boxLabels("claude", "outrunner.example"), {
    "runtime.role": "computer",
    "runtime.engine": "claude",
    [DEPLOYMENT_LABEL]: "outrunner.example",
  });
  assert.deepEqual(boxLabels("jcode", null), { "runtime.role": "computer", "runtime.engine": "jcode" });
});
