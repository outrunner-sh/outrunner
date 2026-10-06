import assert from "node:assert/strict";
import { test } from "node:test";

import {
  localDeviceOf,
  localSandboxId,
  localTransition,
  parseCreateLocation,
  parseLocalEvent,
} from "@/lib/runtime/local-workspace";

test("a create with no location stays in the cloud", () => {
  assert.deepEqual(parseCreateLocation({}), { location: "cloud" });
  assert.deepEqual(parseCreateLocation({ location: "cloud" }), { location: "cloud" });
});

test("a local create must name a well-formed device", () => {
  assert.deepEqual(parseCreateLocation({ location: "local", deviceId: "a1b2" }), {
    location: "local",
    deviceId: "a1b2",
  });
  for (const deviceId of [undefined, "", "../x", "a b", 42]) {
    assert.ok("error" in parseCreateLocation({ location: "local", deviceId }), String(deviceId));
  }
  assert.ok("error" in parseCreateLocation({ location: "moon" }));
});

test("the sandbox id records which Mac a local workspace is on", () => {
  const sandboxId = localSandboxId("dev-1");
  assert.equal(localDeviceOf({ provider: "desktop", sandboxId }), "dev-1");
  // A cloud workspace has no device, whatever its sandbox id looks like.
  assert.equal(localDeviceOf({ provider: "daytona", sandboxId }), null);
  assert.equal(localDeviceOf({ provider: "desktop", sandboxId: null }), null);
});

test("ready must carry an absolute worktree path", () => {
  assert.deepEqual(parseLocalEvent({ event: "ready", worktreePath: "/Users/a/.outrunner/workspaces/w" }), {
    event: "ready",
    worktreePath: "/Users/a/.outrunner/workspaces/w",
  });
  assert.equal(parseLocalEvent({ event: "ready", worktreePath: "relative" }), null);
  assert.equal(parseLocalEvent({ event: "ready" }), null);
  assert.equal(parseLocalEvent({ event: "explode" }), null);
  assert.equal(parseLocalEvent(null), null);
});

test("a failure keeps a bounded message, or a default", () => {
  const long = parseLocalEvent({ event: "failed", error: "x".repeat(2_000) });
  assert.ok(long?.event === "failed" && long.error.length === 500);
  const blank = parseLocalEvent({ event: "failed", error: "  " });
  assert.ok(blank?.event === "failed" && blank.error.length > 0);
});

test("transitions only leave the states they belong to", () => {
  const ready = localTransition({ event: "ready", worktreePath: "/w" });
  assert.deepEqual(ready.from, ["creating", "provisioning"]);
  assert.equal(ready.patch.status, "ready");
  assert.equal(ready.patch.worktreePath, "/w");

  // A late "failed" report cannot knock a ready workspace over.
  assert.ok(!localTransition({ event: "failed", error: "x" }).from.includes("ready"));
  assert.ok(localTransition({ event: "resumed" }).from.includes("suspended"));
  assert.ok(!localTransition({ event: "suspended" }).from.includes("suspended"));
  assert.ok(!localTransition({ event: "destroyed" }).from.includes("destroyed"));
});
