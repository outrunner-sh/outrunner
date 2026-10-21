import assert from "node:assert/strict";
import { test } from "node:test";

import { boxNeeded, releaseBoxIfUnused, type ReleaseBoxDeps } from "@/lib/billing/release-box";
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
