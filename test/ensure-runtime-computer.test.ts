import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ensureRuntimeComputer,
  type EnsureRuntimeComputerDependencies,
  type RuntimeComputerProvisioner,
} from "@/lib/runtime/ensure-runtime-computer";
import { endedBoxOf } from "@/lib/runtime/sandbox-choice";
import type { RuntimeComputer } from "@/lib/runtime/types";
import { abandonedBoxClaim } from "@/lib/session/provisioning";

function computer(overrides: Partial<RuntimeComputer> = {}): RuntimeComputer {
  return {
    id: "computer-1",
    ownerId: "owner-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    pooled: false,
    poolSlot: 0,
    generation: null,
    status: "provisioning",
    imageVersion: "v1",
    daytonaSandboxId: null,
    provider: null,
    agentBaseUrl: null,
    provisionTimings: null,
    errorMessage: null,
    lastActiveAt: null,
    createdAt: "2026-08-05T00:00:00Z",
    updatedAt: "2026-08-05T00:00:00Z",
    ...overrides,
  };
}

/**
 * A faithful in-memory stand-in for the claim RPC: its claim operation is
 * atomic, while provision happens outside it. This exercises the actual
 * orchestration boundary where concurrent first-workspace requests used to
 * create duplicate Daytona boxes.
 */
function concurrencyHarness() {
  let row: RuntimeComputer | null = null;
  let secret: string | null = null;

  const deps: EnsureRuntimeComputerDependencies = {
    claim: async (input) => {
      if (!row) {
        row = computer();
        secret = input.agentSecret;
        return { computer: row, shouldProvision: true };
      }
      if (row.status === "error" || row.status === "stopped") {
        row = {
          ...row,
          status: "provisioning",
          daytonaSandboxId: null,
          agentBaseUrl: null,
          provisionTimings: null,
          errorMessage: null,
        };
        secret = input.agentSecret;
        return { computer: row, shouldProvision: true };
      }
      return { computer: row, shouldProvision: false };
    },
    get: async () => row,
    readSecret: async () => secret,
    update: async (_id, _ownerId, patch) => {
      assert.ok(row);
      row = {
        ...row,
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.daytonaSandboxId !== undefined && {
          daytonaSandboxId: patch.daytonaSandboxId,
        }),
        ...(patch.provider !== undefined && { provider: patch.provider }),
        ...(patch.agentBaseUrl !== undefined && { agentBaseUrl: patch.agentBaseUrl }),
        ...(patch.provisionTimings !== undefined && {
          provisionTimings: patch.provisionTimings,
        }),
        ...(patch.errorMessage !== undefined && { errorMessage: patch.errorMessage }),
      };
    },
    sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)),
    now: Date.now,
  };

  return { deps, row: () => row };
}

const input = {
  scope: { workspaceId: "workspace-1" },
  repoFullName: "acme/runtime",
};

test("concurrent first-workspace ensures provision exactly one Runtime Computer", async () => {
  const harness = concurrencyHarness();
  let provisions = 0;
  const sizes: unknown[] = [];
  const provider: RuntimeComputerProvisioner = {
    name: "neev",
    provisionComputer: async (request) => {
      provisions += 1;
      sizes.push(request.size);
      // Keep the owner request in the external-provision phase long enough
      // for its peer to observe the durable provisioning row and wait.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        sandboxId: "daytona-1",
        agentBaseUrl: "https://agent.example.test",
        timings: { stages: [{ stage: "sandbox_create", ms: 10 }], totalMs: 10 },
      };
    },
  };

  const sized = { ...input, size: { cpu: 4, memoryGb: 8 } };
  const [first, second] = await Promise.all([
    ensureRuntimeComputer(provider, sized, harness.deps),
    ensureRuntimeComputer(provider, sized, harness.deps),
  ]);

  assert.equal(provisions, 1);
  assert.equal(first.computer.id, second.computer.id);
  assert.equal([first.provisioned, second.provisioned].filter(Boolean).length, 1);
  assert.equal(harness.row()?.status, "ready");
  // So a later session knows which provider has the box.
  assert.equal(harness.row()?.provider, "neev");
  // The box is made at the size asked for.
  assert.deepEqual(sizes, [{ cpu: 4, memoryGb: 8 }]);
});

test("a provision failure is persisted as an error for a later retry", async () => {
  const harness = concurrencyHarness();
  await assert.rejects(
    () =>
      ensureRuntimeComputer(
        { name: "daytona", provisionComputer: async () => Promise.reject(new Error("Daytona unavailable")) },
        input,
        harness.deps,
      ),
    /Daytona unavailable/,
  );

  assert.equal(harness.row()?.status, "error");
  assert.match(harness.row()?.errorMessage ?? "", /provisioning failed/i);
});

test("the plan's box cap rides along to the claim, null when there is none", async () => {
  const harness = concurrencyHarness();
  const seen: Array<number | null | undefined> = [];
  const claim: EnsureRuntimeComputerDependencies["claim"] = async (input) => {
    seen.push(input.maxLiveComputers);
    return harness.deps.claim({
      scope: input.scope,
      agentSecret: input.agentSecret,
      maxLiveComputers: input.maxLiveComputers,
    });
  };
  const provider: RuntimeComputerProvisioner = {
    name: "daytona",
    provisionComputer: async () => ({
      sandboxId: "daytona-cap",
      agentBaseUrl: "https://agent.example.test",
      timings: { stages: [{ stage: "sandbox_create", ms: 1 }], totalMs: 1 },
    }),
  };

  await ensureRuntimeComputer(provider, { ...input, maxLiveComputers: 2 }, { ...harness.deps, claim });
  await ensureRuntimeComputer(provider, input, { ...harness.deps, claim });

  assert.deepEqual(seen, [2, null]);
});


test("a failed Runtime Computer can be claimed and provisioned by a retry", async () => {
  const harness = concurrencyHarness();
  let provisions = 0;
  const provider: RuntimeComputerProvisioner = {
    name: "neev",
    provisionComputer: async () => {
      provisions += 1;
      if (provisions === 1) throw new Error("Daytona unavailable");
      return {
        sandboxId: "daytona-retry",
        agentBaseUrl: "https://agent.example.test",
        timings: { stages: [{ stage: "sandbox_create", ms: 10 }], totalMs: 10 },
      };
    },
  };

  await assert.rejects(() => ensureRuntimeComputer(provider, input, harness.deps));

  const retried = await ensureRuntimeComputer(provider, input, harness.deps);

  assert.equal(provisions, 2);
  assert.equal(retried.provisioned, true);
  assert.equal(harness.row()?.status, "ready");
  assert.equal(harness.row()?.daytonaSandboxId, "daytona-retry");
});

test("a box that ended is handed to the provider to restore from", async () => {
  const harness = concurrencyHarness();
  const asked: unknown[] = [];
  const provider: RuntimeComputerProvisioner = {
    name: "user-modal",
    provisionComputer: async (request) => {
      asked.push(request.previousSandboxId);
      return {
        sandboxId: "sb-restored",
        agentBaseUrl: "https://agent.example.test",
        timings: { stages: [{ stage: "sandbox_restore", ms: 10 }], totalMs: 10 },
      };
    },
  };

  await ensureRuntimeComputer(provider, { ...input, previousSandboxId: "sb-ended" }, harness.deps);

  assert.deepEqual(asked, ["sb-ended"]);
  assert.equal(harness.row()?.daytonaSandboxId, "sb-restored");
});

test("a restore that fails keeps the ended box, so a retry restores from it again", async () => {
  const harness = concurrencyHarness();
  const asked: unknown[] = [];
  const provider: RuntimeComputerProvisioner = {
    name: "user-modal",
    provisionComputer: async (request) => {
      asked.push(request.previousSandboxId);
      if (asked.length === 1) throw new Error("Modal unavailable");
      return {
        sandboxId: "sb-restored",
        agentBaseUrl: "https://agent.example.test",
        timings: { stages: [{ stage: "sandbox_restore", ms: 10 }], totalMs: 10 },
      };
    },
  };

  const ended = { ...input, previousSandboxId: "sb-ended" };
  await assert.rejects(() => ensureRuntimeComputer(provider, ended, harness.deps), /Modal unavailable/);
  // Stopped with the ended box, as a box found ended is, not an error with none.
  assert.equal(harness.row()?.status, "stopped");
  assert.equal(harness.row()?.daytonaSandboxId, "sb-ended");

  await ensureRuntimeComputer(provider, ended, harness.deps);
  assert.deepEqual(asked, ["sb-ended", "sb-ended"]);
  assert.equal(harness.row()?.status, "ready");
});

test("cloud hours start when this request's box is up, at the box's own size, and never fail the provision", async () => {
  const harness = concurrencyHarness();
  const started: string[] = [];
  const provider: RuntimeComputerProvisioner = {
    name: "neev",
    provisionComputer: async () => ({
      sandboxId: "sb-new",
      agentBaseUrl: "https://agent.example.test",
      timings: { stages: [], totalMs: 0 },
      // Made Medium; the user has since picked X Small: the box keeps 4.
      cpu: 4,
    }),
  };
  const deps = {
    ...harness.deps,
    started: async (c: RuntimeComputer, cpu: number | undefined) => {
      started.push(`${c.daytonaSandboxId} at ${cpu} vCPU`);
      throw new Error("database down");
    },
  };

  const ensured = await ensureRuntimeComputer(provider, { ...input, size: { cpu: 1, memoryGb: 2 } }, deps);
  assert.equal(ensured.provisioned, true);
  assert.deepEqual(started, ["sb-new at 4 vCPU"]);

  // A request that waited on another's provision doesn't start them again.
  await ensureRuntimeComputer(provider, input, deps);
  assert.deepEqual(started, ["sb-new at 4 vCPU"]);
});

test("the claim and the wait are for the box of the scope asked for", async () => {
  const harness = concurrencyHarness();
  const claimed: unknown[] = [];
  const read: unknown[] = [];
  const deps: EnsureRuntimeComputerDependencies = {
    ...harness.deps,
    claim: async (claim) => (claimed.push(claim.scope), harness.deps.claim(claim)),
    get: async (scope) => (read.push(scope), harness.deps.get(scope)),
  };
  const provider: RuntimeComputerProvisioner = {
    name: "daytona",
    provisionComputer: async () => ({
      sandboxId: "daytona-own",
      agentBaseUrl: "https://agent.example.test",
      timings: { stages: [{ stage: "sandbox_create", ms: 1 }], totalMs: 1 },
    }),
  };
  const shared = { projectId: "project-1" };
  await ensureRuntimeComputer(provider, { ...input, scope: shared }, deps);
  assert.deepEqual(claimed, [shared]);
  assert.deepEqual(read, [shared]);
});

test("a box that ended is named on its row while it's brought back", async () => {
  const harness = concurrencyHarness();
  await harness.deps.claim({ scope: input.scope, agentSecret: "s", maxLiveComputers: null });
  await harness.deps.update("computer-1", "owner-1", { status: "stopped", daytonaSandboxId: "sb-ended" });
  let named: string | null | undefined;
  const provider: RuntimeComputerProvisioner = {
    name: "daytona",
    provisionComputer: async () => {
      // The claim cleared it; the box is named again before it's started.
      named = harness.row()?.daytonaSandboxId;
      return {
        sandboxId: "sb-ended",
        agentBaseUrl: "https://agent.example.test",
        timings: { stages: [{ stage: "sandbox_restore", ms: 1 }], totalMs: 1 },
      };
    },
  };

  await ensureRuntimeComputer(provider, { ...input, previousSandboxId: "sb-ended" }, harness.deps);
  assert.equal(named, "sb-ended");
  assert.equal(harness.row()?.status, "ready");
});

test("a box provisioned but never recorded as ready is deleted, not left running", async () => {
  const harness = concurrencyHarness();
  const destroyed: string[] = [];
  const paused: string[] = [];
  const provider: RuntimeComputerProvisioner = {
    name: "daytona",
    provisionComputer: async () => ({
      sandboxId: "sb-new",
      agentBaseUrl: "https://agent.example.test",
      timings: { stages: [{ stage: "sandbox_create", ms: 1 }], totalMs: 1 },
    }),
    destroyComputer: async (id) => void destroyed.push(id),
    pauseComputer: async (id) => void paused.push(id),
  };
  let writes = 0;
  const deps: EnsureRuntimeComputerDependencies = {
    ...harness.deps,
    update: async (id, ownerId, patch) => {
      // The write recording it ready fails; the failure's own goes through.
      if (patch.status === "ready" && ++writes === 1) throw new Error("database down");
      return harness.deps.update(id, ownerId, patch);
    },
  };

  await assert.rejects(() => ensureRuntimeComputer(provider, input, deps), /database down/);
  assert.deepEqual(destroyed, ["sb-new"]);
  assert.deepEqual(paused, []);
  assert.equal(harness.row()?.status, "error");
});

test("an ended box brought back in place but not recorded is paused again, never deleted", async () => {
  const harness = concurrencyHarness();
  const destroyed: string[] = [];
  const paused: string[] = [];
  const provider: RuntimeComputerProvisioner = {
    name: "daytona",
    provisionComputer: async () => ({
      sandboxId: "sb-ended",
      agentBaseUrl: "https://agent.example.test",
      timings: { stages: [{ stage: "sandbox_restore", ms: 1 }], totalMs: 1 },
    }),
    destroyComputer: async (id) => void destroyed.push(id),
    pauseComputer: async () => {
      paused.push("sb-ended");
      throw new Error("Daytona unavailable");
    },
  };
  const deps: EnsureRuntimeComputerDependencies = {
    ...harness.deps,
    // The write recording it ready fails; the rest go through.
    update: async (id, ownerId, patch) => {
      if (patch.status === "ready") throw new Error("database down");
      return harness.deps.update(id, ownerId, patch);
    },
  };

  await assert.rejects(
    () => ensureRuntimeComputer(provider, { ...input, previousSandboxId: "sb-ended" }, deps),
    /database down/,
  );
  assert.deepEqual(paused, ["sb-ended"]);
  assert.deepEqual(destroyed, []);
  // Stopped on the box that ended, for the next try to bring back.
  assert.equal(harness.row()?.status, "stopped");
  assert.equal(harness.row()?.daytonaSandboxId, "sb-ended");
});

test("a box recorded as ready is never let go of, whatever fails after", async () => {
  const harness = concurrencyHarness();
  const destroyed: string[] = [];
  const provider: RuntimeComputerProvisioner = {
    name: "daytona",
    provisionComputer: async () => ({
      sandboxId: "sb-new",
      agentBaseUrl: "https://agent.example.test",
      timings: { stages: [{ stage: "sandbox_create", ms: 1 }], totalMs: 1 },
    }),
    destroyComputer: async (id) => void destroyed.push(id),
  };
  const deps: EnsureRuntimeComputerDependencies = {
    ...harness.deps,
    // The read back blips after the ready write landed.
    get: async () => Promise.reject(new Error("network blip")),
  };

  await assert.rejects(() => ensureRuntimeComputer(provider, input, deps), /network blip/);
  assert.deepEqual(destroyed, []);
  // And the row still names it, ready, for the reconciler to meter and stop.
  assert.equal(harness.row()?.status, "ready");
  assert.equal(harness.row()?.daytonaSandboxId, "sb-new");
});

test("a box claim a restart cut off holds every later open until the sweep lets it go", async () => {
  const harness = concurrencyHarness();
  // A paused box being brought back when the server stops: its provision
  // never ends, and the row says provisioning, naming the box.
  const cutOff: RuntimeComputerProvisioner = {
    name: "daytona",
    provisionComputer: () => new Promise(() => undefined),
  };
  void ensureRuntimeComputer(cutOff, { ...input, previousSandboxId: "box-paused" }, harness.deps);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Made by Daytona when it first ran: the claim leaves that as it was.
  await harness.deps.update("computer-1", "owner-1", { provider: "daytona" });
  assert.equal(harness.row()?.status, "provisioning");
  assert.equal(harness.row()?.daytonaSandboxId, "box-paused");

  // Every later open waits on that claim, then fails.
  let clock = 0;
  const waiting = { ...harness.deps, now: () => clock, sleep: async () => void (clock += 60_000) };
  const resumed: (string | undefined)[] = [];
  const provider: RuntimeComputerProvisioner = {
    name: "daytona",
    provisionComputer: async (request) => {
      resumed.push(request.previousSandboxId);
      return { sandboxId: request.previousSandboxId ?? "box-new", agentBaseUrl: "https://agent.example.test", timings: { stages: [], totalMs: 0 } };
    },
  };
  await assert.rejects(ensureRuntimeComputer(provider, input, waiting), /Timed out waiting/);

  // The sweep leaves it as its provision's own failure would: stopped, still
  // naming the box, which the next open brings back with its sessions.
  const swept = abandonedBoxClaim(harness.row()?.daytonaSandboxId ?? null);
  await harness.deps.update("computer-1", "owner-1", { status: swept.status, errorMessage: swept.errorMessage });
  const row = harness.row();
  const ended = endedBoxOf(row, "daytona");
  assert.equal(ended, "box-paused");
  const ensured = await ensureRuntimeComputer(provider, { ...input, previousSandboxId: ended }, waiting);
  assert.equal(ensured.provisioned, true);
  assert.deepEqual(resumed, ["box-paused"]);
  assert.equal(harness.row()?.status, "ready");
});
