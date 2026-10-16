import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { SandboxChoice, SandboxSettings } from "@/lib/db/credentials";
import type { BoxSizeId } from "@/lib/runtime/box-sizes";
import { NoDaytonaKeyError, UserDaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import { resetRuntimeProvider } from "@/lib/runtime/provider";
import {
  computerMadeBy,
  endedBoxOf,
  newBoxSize,
  providerForNewSessions,
  providerNamed,
} from "@/lib/runtime/sandbox-choice";
import { NoModalTokenError, UserModalRuntimeProvider } from "@/lib/runtime/user-modal-provider";

const noKey = { daytona: async () => null, modal: async () => null };
const settings = (sandbox: SandboxChoice, connected: boolean, boxSize: BoxSizeId = "small"): SandboxSettings => ({
  sandbox,
  daytona: { connected, hint: connected ? "ab12" : null, updatedAt: null },
  modal: { connected, hint: connected ? "cd34" : null, updatedAt: null },
  boxSize,
});

const saved = process.env.RUNTIME_PROVIDER;
beforeEach(() => {
  process.env.RUNTIME_PROVIDER = "neev";
  resetRuntimeProvider();
});
afterEach(() => {
  if (saved === undefined) delete process.env.RUNTIME_PROVIDER;
  else process.env.RUNTIME_PROVIDER = saved;
  resetRuntimeProvider();
});

test("a session on the deployment's provider is managed with it", () => {
  assert.equal(providerNamed("neev", noKey)?.name, "neev");
});

test("a session in the owner's own Daytona is managed on their key, whatever the deployment runs", () => {
  const provider = providerNamed("user-daytona", noKey);
  assert.ok(provider instanceof UserDaytonaRuntimeProvider);
  assert.equal(provider.name, "user-daytona");
});

test("a session in the owner's own Modal is managed on their token", () => {
  const provider = providerNamed("user-modal", noKey);
  assert.ok(provider instanceof UserModalRuntimeProvider);
  assert.equal(provider.name, "user-modal");
  assert.equal(provider.restoresBoxes, true);
});

test("a session on a provider this deployment no longer runs has none, rather than another's", () => {
  assert.equal(providerNamed("daytona", noKey), null);
});

test("new sessions go where the user chose: Outrunner's by default, their Daytona with a key", () => {
  assert.equal(providerForNewSessions(settings("outrunner", false), noKey).name, "neev");
  assert.equal(providerForNewSessions(settings("outrunner", true), noKey).name, "neev");
  assert.equal(providerForNewSessions(settings("daytona", true), noKey).name, "user-daytona");
  assert.throws(() => providerForNewSessions(settings("daytona", false), noKey), NoDaytonaKeyError);
  assert.equal(providerForNewSessions(settings("modal", true), noKey).name, "user-modal");
  assert.throws(() => providerForNewSessions(settings("modal", false), noKey), NoModalTokenError);
});

test("a new box is the user's size on Outrunner's and their Modal; Large only on their Modal", () => {
  const cpuAndMemory = (size?: { cpu: number; memoryGb: number }) => size && [size.cpu, size.memoryGb];
  assert.deepEqual(cpuAndMemory(newBoxSize(settings("outrunner", false, "medium"))), [4, 8]);
  assert.deepEqual(cpuAndMemory(newBoxSize(settings("modal", true, "large"))), [8, 16]);
  // Large is for a higher plan on Outrunner's: one chosen for Modal is the default there.
  assert.deepEqual(cpuAndMemory(newBoxSize(settings("outrunner", false, "large"))), [2, 4]);
  // Their own Daytona keeps its own size.
  assert.equal(newBoxSize(settings("daytona", true, "medium")), undefined);
});

test("the owner's Modal with no token says where to add one, when a box is first reached", async () => {
  const provider = new UserModalRuntimeProvider(async () => null);
  await assert.rejects(provider.agentTarget("sb-1", "secret"), (error: unknown) => {
    assert.ok(error instanceof NoModalTokenError);
    assert.match(error.message, /Settings → Sandbox/);
    return true;
  });
});

test("a computer from before providers were recorded is the deployment's", () => {
  assert.equal(computerMadeBy({ provider: null }), "neev");
  assert.equal(computerMadeBy({ provider: "user-daytona" }), "user-daytona");
});

test("the owner's Daytona with no key says where to add one, at the first call that needs it", async () => {
  let reads = 0;
  const provider = new UserDaytonaRuntimeProvider(async () => {
    reads += 1;
    return null;
  });
  assert.equal(reads, 0, "constructing it reads nothing");
  await assert.rejects(provider.agentTarget("box-1", "secret"), (error: unknown) => {
    assert.ok(error instanceof NoDaytonaKeyError);
    assert.match(error.message, /Settings → Sandbox/);
    return true;
  });
  // Not cached: a key added meanwhile is read next time.
  await assert.rejects(provider.agentTarget("box-1", "secret"), NoDaytonaKeyError);
  assert.equal(reads, 2);
});

test("only a stopped computer the same provider made is a box to restore from", () => {
  const stopped = { status: "stopped" as const, daytonaSandboxId: "sb-1", provider: "user-modal" as const };
  assert.equal(endedBoxOf(stopped, "user-modal"), "sb-1");
  // Up, or never had a box.
  assert.equal(endedBoxOf({ ...stopped, status: "ready" }, "user-modal"), undefined);
  assert.equal(endedBoxOf({ ...stopped, daytonaSandboxId: null }, "user-modal"), undefined);
  // Another provider's box: the owner moved, and that one is retired, not restored.
  assert.equal(endedBoxOf({ ...stopped, provider: "neev" }, "user-modal"), undefined);
  assert.equal(endedBoxOf(null, "user-modal"), undefined);
});
