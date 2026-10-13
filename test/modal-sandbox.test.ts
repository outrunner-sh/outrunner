import assert from "node:assert/strict";
import { test } from "node:test";

import { InvalidError, NotFoundError, SnapshotCreationError, TimeoutError } from "modal";

import { AGENT_PORT } from "@/lib/runtime/daytona/deploy";
import { MODAL_IMAGE_SETUP, noSnapshot, sandboxParams } from "@/lib/runtime/sandbox/modal";

test("a box lives as long as Modal allows, opens the agent's port, and leaves a snapshot when it ends", () => {
  const params = sandboxParams({ "runtime.role": "computer" }, { cpu: 4, memoryGb: 8 });
  assert.equal(params.timeoutMs, 24 * 60 * 60 * 1000);
  assert.deepEqual(params.encryptedPorts, [AGENT_PORT]);
  assert.deepEqual(params.experimentalOptions, { enable_exit_snapshot: true });
  // Kept up by its own command, not ended when the image's default one exits.
  assert.deepEqual(params.command, ["sleep", "infinity"]);
  assert.deepEqual(params.tags, { "runtime.role": "computer" });
  assert.equal(params.cpu, 4);
  assert.equal(params.memoryMiB, 8 * 1024);
});

test("a box with no size asked for gets Outrunner's default, not Modal's eighth of a CPU", () => {
  const params = sandboxParams({});
  assert.equal(params.cpu, 2);
  assert.equal(params.memoryMiB, 4 * 1024);
});

test("the image has what the agent needs, and the user Claude runs as", () => {
  const setup = MODAL_IMAGE_SETUP.join("\n");
  for (const part of ["tmux", "jq", "useradd -m", "claude.ai/install.sh"]) {
    assert.ok(setup.includes(part), `the image lacks ${part}`);
  }
  // Installed by the box user, so Claude Code can update itself.
  assert.match(setup, /su - runtime -c '[^']*install\.sh/);
});

test("only a missing, never-taken or failed snapshot means there's no disk to restore", () => {
  assert.equal(noSnapshot(new NotFoundError("gone")), true);
  assert.equal(noSnapshot(new InvalidError("exit snapshots not enabled")), true);
  assert.equal(noSnapshot(new SnapshotCreationError("failed")), true);
  // Not yet known: worth trying again rather than starting over.
  assert.equal(noSnapshot(new TimeoutError("still pending")), false);
  assert.equal(noSnapshot(new Error("network")), false);
});
