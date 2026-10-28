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

const DEPLOYMENT = "outrunner.example";
const options = { now: NOW, deployment: DEPLOYMENT, unlabelled: true };
const ours = (overrides: Partial<ListedBox> = {}) =>
  box({ ...overrides, labels: { ...box().labels, [DEPLOYMENT_LABEL]: DEPLOYMENT, ...overrides.labels } });

test("a box of this deployment's no row names, old and quiet, is deleted", () => {
  assert.deepEqual(orphanedBoxes([ours()], new Set(), { ...options, unlabelled: false }), { remove: ["sb-1"], held: [] });
  // Stopped (paused) boxes cost their disk: swept too.
  assert.deepEqual(
    orphanedBoxes([ours({ state: "stopped" }), ours({ id: "sb-2", state: "error" })], new Set(), options).remove,
    ["sb-1", "sb-2"],
  );
});

test("a box a row names is never swept, whatever its age", () => {
  assert.deepEqual(orphanedBoxes([ours({ createdAt: ago(60 * 24 * HOUR) })], new Set(["sb-1"]), options), { remove: [], held: [] });
});

test("only boxes labelled as Outrunner's computers", () => {
  assert.equal(sweepable(box({ labels: {} }), NOW, DEPLOYMENT), false);
  assert.equal(sweepable(box({ labels: { "runtime.role": "something-else" } }), NOW, DEPLOYMENT), false);
});

test("a box another deployment made is left alone; a deployment with no name sweeps nothing", () => {
  const theirs = box({ labels: { ...box().labels, [DEPLOYMENT_LABEL]: "staging.example" } });
  assert.equal(sweepable(theirs, NOW, DEPLOYMENT), false);
  assert.equal(sweepable(ours(), NOW, DEPLOYMENT), true);
  assert.equal(sweepable(ours(), NOW, null), false);
  assert.equal(sweepable(box(), NOW, null), false);
});

test("an unlabelled box, from before the label, is only held unless the account is this deployment's alone", () => {
  const boxes = [box({ id: "sb-old" }), ours({ id: "sb-new" })];
  assert.deepEqual(orphanedBoxes(boxes, new Set(), { ...options, unlabelled: false }), { remove: ["sb-new"], held: ["sb-old"] });
  assert.deepEqual(orphanedBoxes(boxes, new Set(), options), { remove: ["sb-old", "sb-new"], held: [] });
});

test("a box made or touched within the grace is left: its id may not be recorded yet", () => {
  assert.equal(sweepable(ours({ createdAt: ago(ORPHAN_GRACE_MS - 60_000) }), NOW, DEPLOYMENT), false);
  assert.equal(sweepable(ours({ lastActivityAt: ago(5 * 60_000) }), NOW, DEPLOYMENT), false);
  assert.equal(
    sweepable(ours({ createdAt: ago(ORPHAN_GRACE_MS + 60_000), lastActivityAt: ago(ORPHAN_GRACE_MS + 60_000) }), NOW, DEPLOYMENT),
    true,
  );
});

test("a date that can't be read, or a box on its way into or out of a state, says no", () => {
  assert.equal(sweepable(ours({ createdAt: undefined }), NOW, DEPLOYMENT), false);
  assert.equal(sweepable(ours({ lastActivityAt: undefined }), NOW, DEPLOYMENT), false);
  assert.equal(sweepable(ours({ lastActivityAt: "yesterday" }), NOW, DEPLOYMENT), false);
  for (const state of ["creating", "starting", "restoring", "stopping", "archiving", "destroying", "destroyed", "pausing", "unknown"]) {
    assert.equal(sweepable(ours({ state }), NOW, DEPLOYMENT), false, state);
  }
});

test("at most a run's worth, the longest quiet first, and held boxes don't crowd out ones to delete", () => {
  const boxes = Array.from({ length: ORPHAN_SWEEP_MAX + 5 }, (_, i) => ours({ id: `sb-${i}`, lastActivityAt: ago((3 + i) * HOUR) }));
  const { remove } = orphanedBoxes(boxes, new Set(), options);
  assert.equal(remove.length, ORPHAN_SWEEP_MAX);
  assert.equal(remove[0], `sb-${ORPHAN_SWEEP_MAX + 4}`);
  assert.deepEqual(orphanedBoxes(boxes, new Set(), { ...options, max: 2 }).remove, [
    `sb-${ORPHAN_SWEEP_MAX + 4}`,
    `sb-${ORPHAN_SWEEP_MAX + 3}`,
  ]);
  const older = Array.from({ length: ORPHAN_SWEEP_MAX }, (_, i) => box({ id: `old-${i}`, lastActivityAt: ago(100 * HOUR) }));
  const swept = orphanedBoxes([...older, ours()], new Set(), { ...options, unlabelled: false });
  assert.deepEqual(swept.remove, ["sb-1"]);
  // Held boxes are listed in full, beyond a run's worth.
  const more = [...older, box({ id: "old-extra", lastActivityAt: ago(100 * HOUR) })];
  assert.equal(orphanedBoxes(more, new Set(), { ...options, unlabelled: false }).held.length, ORPHAN_SWEEP_MAX + 1);
  assert.equal(swept.held.length, ORPHAN_SWEEP_MAX);
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
