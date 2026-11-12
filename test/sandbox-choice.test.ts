import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { PLANS } from "@/lib/billing/plans";
import type { SandboxChoice, SandboxSettings } from "@/lib/db/credentials";
import type { BoxSizeId } from "@/lib/runtime/box-sizes";
import { DaytonaRuntimeProvider, NoDaytonaKeyError, UserDaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import { NeevRuntimeProvider } from "@/lib/runtime/neev-provider";
import { getRuntimeProvider, platformComputerProviders, platformProvider, resetRuntimeProvider } from "@/lib/runtime/provider";
import {
  boxSizeOn,
  computerMadeBy,
  endedBoxOf,
  providerForNewSessions,
  providerNamed,
  sandboxOf,
} from "@/lib/runtime/sandbox-choice";
import { NoModalTokenError, UserModalRuntimeProvider } from "@/lib/runtime/user-modal-provider";

const noKey = { daytona: async () => null, modal: async () => null };
const settings = (sandbox: SandboxChoice, connected: boolean, boxSize: BoxSizeId = "small"): SandboxSettings => ({
  sandbox,
  daytona: { connected, hint: connected ? "ab12" : null, updatedAt: null },
  modal: { connected, hint: connected ? "cd34" : null, updatedAt: null },
  boxSize,
  boxSizeChosen: false,
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

/** `fn` with these variables set (undefined: unset), restored after. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  set(vars);
  resetRuntimeProvider();
  try {
    fn();
  } finally {
    set(saved);
    resetRuntimeProvider();
  }
}

const NO_NEEV = { NEEV_API_KEY: undefined, NEEV_ORG_ID: undefined, NEEV_PROJECT_ID: undefined };
const NEEV = { NEEV_API_KEY: "sk-nc-x", NEEV_ORG_ID: "org", NEEV_PROJECT_ID: "proj" };

test("a session on a provider this deployment can't reach has none, rather than another's", () => {
  withEnv({ DAYTONA_API_KEY: undefined }, () => {
    assert.equal(providerNamed("daytona", noKey), null);
    assert.equal(platformProvider("daytona"), null);
  });
});

test("a deployment moved to Neev keeps managing its Daytona boxes while Daytona's key is set", () => {
  withEnv({ RUNTIME_PROVIDER: "neev", DAYTONA_API_KEY: "dtn_x", ...NEEV }, () => {
    const daytona = providerNamed("daytona", noKey);
    assert.ok(daytona instanceof DaytonaRuntimeProvider);
    assert.equal(daytona.name, "daytona");
    assert.equal(providerNamed("daytona", noKey), daytona, "one instance, so endpoints and upgrades are shared");
    // New sessions still go to the deployment's own.
    assert.equal(providerForNewSessions(settings("outrunner", false), noKey).name, "neev");
    assert.ok(getRuntimeProvider() instanceof NeevRuntimeProvider);
    // The reconciler and sweeps go over both, the deployment's first.
    assert.deepEqual(platformComputerProviders().map((p) => p.name), ["neev", "daytona"]);
  });
});

test("rolled back to Daytona, Neev's boxes stay managed while Neev's credentials are set", () => {
  withEnv({ RUNTIME_PROVIDER: "daytona", DAYTONA_API_KEY: "dtn_x", ...NEEV }, () => {
    assert.ok(providerNamed("neev", noKey) instanceof NeevRuntimeProvider);
    assert.deepEqual(platformComputerProviders().map((p) => p.name), ["daytona", "neev"]);
  });
  withEnv({ RUNTIME_PROVIDER: "daytona", DAYTONA_API_KEY: "dtn_x", ...NO_NEEV, NEEV_API_KEY: "sk-nc-x" }, () => {
    assert.equal(providerNamed("neev", noKey), null, "all three Neev variables are needed");
    assert.deepEqual(platformComputerProviders().map((p) => p.name), ["daytona"]);
  });
});

test("a user's own sandbox is never taken for one of Outrunner's", () => {
  withEnv({ RUNTIME_PROVIDER: "neev", DAYTONA_API_KEY: "dtn_x", ...NEEV }, () => {
    assert.equal(platformProvider("user-daytona"), null);
    assert.equal(platformProvider("user-modal"), null);
    assert.equal(platformProvider("local"), null);
  });
});

test("new sessions go where the user chose: Outrunner's by default, their Daytona with a key", () => {
  assert.equal(providerForNewSessions(settings("outrunner", false), noKey).name, "neev");
  assert.equal(providerForNewSessions(settings("outrunner", true), noKey).name, "neev");
  assert.equal(providerForNewSessions(settings("daytona", true), noKey).name, "user-daytona");
  assert.throws(() => providerForNewSessions(settings("daytona", false), noKey), NoDaytonaKeyError);
  assert.equal(providerForNewSessions(settings("modal", true), noKey).name, "user-modal");
  assert.throws(() => providerForNewSessions(settings("modal", false), noKey), NoModalTokenError);
});

test("a box is the user's size on their Modal, within their plan on Outrunner's, and Daytona's own", () => {
  const cpuAndMemory = (size?: { cpu: number; memoryGb: number }) => size && [size.cpu, size.memoryGb];
  // Free goes up to Small on Outrunner's: a larger choice is Small, a smaller one kept.
  assert.deepEqual(cpuAndMemory(boxSizeOn("outrunner", "x-small", PLANS.free)), [1, 2]);
  assert.deepEqual(cpuAndMemory(boxSizeOn("outrunner", "medium", PLANS.free)), [2, 4]);
  assert.deepEqual(cpuAndMemory(boxSizeOn("outrunner", "large", PLANS.free)), [2, 4]);
  // Pro up to Medium, Max to Large.
  assert.deepEqual(cpuAndMemory(boxSizeOn("outrunner", "large", PLANS.pro)), [4, 8]);
  assert.deepEqual(cpuAndMemory(boxSizeOn("outrunner", "large", PLANS.max)), [8, 16]);
  // Their own Modal bills them: any size, whatever the plan.
  assert.deepEqual(cpuAndMemory(boxSizeOn("modal", "large", PLANS.free)), [8, 16]);
  // Their own Daytona keeps its own size.
  assert.equal(boxSizeOn("daytona", "medium", PLANS.max), undefined);
});

test("a box brought back is sized as the sandbox that made it, not where new sessions now go", () => {
  assert.equal(sandboxOf("user-modal"), "modal");
  assert.equal(sandboxOf("user-daytona"), "daytona");
  assert.equal(sandboxOf("neev"), "outrunner");
  assert.equal(sandboxOf("daytona"), "outrunner");
});

test("the owner's Modal with no token says where to add one, when a box is first reached", async () => {
  const provider = new UserModalRuntimeProvider(async () => null);
  await assert.rejects(provider.agentTarget("sb-1", "secret"), (error: unknown) => {
    assert.ok(error instanceof NoModalTokenError);
    assert.match(error.message, /deployment administrator/);
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
    assert.match(error.message, /deployment administrator/);
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
