import assert from "node:assert/strict";
import { test } from "node:test";

import { boxDroppableAfterArchive, boxNeeded, deleteOwnBox, ownBoxDeleted, releaseBoxIfUnused, type ReleaseBoxDeps } from "@/lib/billing/release-box";
import { AGENT_FEATURE_SNAPSHOT_PATCH_INTEGRITY } from "@/lib/runtime/agent-protocol";
import type { RuntimeComputerStatus, WorkspaceStatus } from "@/lib/runtime/types";

const NOW = new Date("2026-10-22T12:00:00Z");

/** A project with one computer and its sessions; every write lands in `log`. */
function project(opts: {
  sessions: WorkspaceStatus[];
  computer?: { status: RuntimeComputerStatus; sandboxId: string | null } | null;
  pauses?: boolean;
}) {
  const log: string[] = [];
  const computer = opts.computer === undefined ? { status: "ready" as const, sandboxId: "sb-1" } : opts.computer;
  const deps: ReleaseBoxDeps = {
    pausesBoxes: opts.pauses ?? true,
    computer: async () => computer && { id: "c-1", status: computer.status, daytonaSandboxId: computer.sandboxId },
    sessions: async () => opts.sessions.map((status) => ({ status })),
    pause: async (sandboxId) => void log.push(`pause ${sandboxId}`),
    closeInterval: async (sandboxId, at) => void log.push(`close ${sandboxId} at ${at.toISOString()}`),
    markStopped: async (computerId, sandboxId) => void log.push(`stopped ${computerId} on ${sandboxId}`),
    now: () => NOW,
  };
  return { deps, log };
}

test("the last session archived or ended pauses its box, as the reconciler would", async () => {
  const { deps, log } = project({ sessions: ["archived", "destroyed", "failed"] });
  assert.equal(await releaseBoxIfUnused(deps), true);
  assert.deepEqual(log, ["pause sb-1", `close sb-1 at ${NOW.toISOString()}`, "stopped c-1 on sb-1"]);
});

test("a box any session still needs keeps running", () => {
  // Running, suspended (resume needs the box up), or still changing: an
  // archive under way frees the box itself when it lands.
  for (const status of ["ready", "idle", "suspended", "creating", "provisioning", "archiving", "restoring", "destroying"] as const) {
    assert.equal(boxNeeded([{ status: "archived" }, { status }]), true, status);
  }
  assert.equal(boxNeeded([]), false);
});

test("nothing is paused where there is no ready box, or it can't come back", async () => {
  for (const opts of [
    { sessions: ["ready" as const] },
    { sessions: [], pauses: false },
    { sessions: [], computer: null },
    { sessions: [], computer: { status: "stopped" as const, sandboxId: "sb-1" } },
    { sessions: [], computer: { status: "ready" as const, sandboxId: null } },
  ]) {
    const { deps, log } = project(opts);
    assert.equal(await releaseBoxIfUnused(deps), false);
    assert.deepEqual(log, []);
  }
});

test("an ended session's own box is deleted, then its interval closed, running or paused", async () => {
  for (const status of ["ready", "stopped"] as const) {
    const log: string[] = [];
    const deleted = await deleteOwnBox({
      computer: async () => ({ id: "c-1", daytonaSandboxId: "sb-1", status }),
      delete: async (sandboxId) => void log.push(`delete ${sandboxId}`),
      closeInterval: async (sandboxId, at) => void log.push(`close ${sandboxId} at ${at.toISOString()}`),
      markDeleted: async (computerId) => void log.push(`deleted ${computerId}`),
      now: () => NOW,
    });
    assert.equal(deleted, true, status);
    assert.deepEqual(log, ["delete sb-1", `close sb-1 at ${NOW.toISOString()}`, "deleted c-1"], status);
  }
});

test("a session with no box of its own has nothing to delete", async () => {
  const log: string[] = [];
  for (const computer of [null, { id: "c-1", daytonaSandboxId: null }]) {
    const deleted = await deleteOwnBox({
      computer: async () => computer,
      delete: async () => void log.push("delete"),
      closeInterval: async () => void log.push("close"),
      markDeleted: async () => void log.push("mark"),
      now: () => NOW,
    });
    assert.equal(deleted, false);
  }
  assert.deepEqual(log, []);
});

test("a box that won't delete stays metered: its interval is left open", async () => {
  const log: string[] = [];
  await assert.rejects(
    deleteOwnBox({
      computer: async () => ({ id: "c-1", daytonaSandboxId: "sb-1" }),
      delete: async () => {
        throw new Error("Daytona said no");
      },
      closeInterval: async () => void log.push("close"),
      markDeleted: async () => void log.push("mark"),
      now: () => NOW,
    }),
    /Daytona said no/,
  );
  assert.deepEqual(log, []);
});

test("a session's own box is deleted when it ends, is archived by Outrunner, or can't be paused; else paused", () => {
  assert.equal(ownBoxDeleted({ ended: true, pausesBoxes: true }), true);
  // An automation's superseded review: its Snapshot is saved, and a paused box
  // would hold its whole disk on the shared storage quota.
  assert.equal(ownBoxDeleted({ ended: false, dropBox: true, pausesBoxes: true }), true);
  assert.equal(ownBoxDeleted({ ended: false, pausesBoxes: false }), true);
  // Archived by its user: paused, so Restore brings it back on its disk.
  assert.equal(ownBoxDeleted({ ended: false, pausesBoxes: true }), false);
  assert.equal(ownBoxDeleted({ ended: false, dropBox: false, pausesBoxes: true }), false);
});

test("an archive drops its box only when the agent that captured it fails a broken git diff", () => {
  assert.equal(boxDroppableAfterArchive(true, ["chats", AGENT_FEATURE_SNAPSHOT_PATCH_INTEGRITY]), true);
  // An older agent saves an empty patch on a failed diff: its box is paused,
  // so the session's changes are still on its disk.
  assert.equal(boxDroppableAfterArchive(true, ["chats"]), false);
  assert.equal(boxDroppableAfterArchive(true, []), false);
  assert.equal(boxDroppableAfterArchive(false, [AGENT_FEATURE_SNAPSHOT_PATCH_INTEGRITY]), false);
  assert.equal(boxDroppableAfterArchive(undefined, [AGENT_FEATURE_SNAPSHOT_PATCH_INTEGRITY]), false);
});
