import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ensureRuntimeComputer,
  type EnsureRuntimeComputerDependencies,
  type RuntimeComputerProvisioner,
} from "@/lib/runtime/ensure-runtime-computer";
import type { RuntimeComputer } from "@/lib/runtime/types";

function computer(overrides: Partial<RuntimeComputer> = {}): RuntimeComputer {
  return {
    id: "computer-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
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
    update: async (_id, patch) => {
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
