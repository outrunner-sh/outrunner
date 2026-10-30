import assert from "node:assert/strict";
import { test } from "node:test";

import { PLANS } from "@/lib/billing/plans";
import { mediaRequestSignature } from "@/lib/media/box-auth";
import { boxSize } from "@/lib/runtime/box-sizes";
import { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { requestMemoryScale, type MemoryScaleDeps } from "@/lib/runtime/memory-scale-request";
import { growMemoryUnderPressure, memoryPressure } from "@/lib/runtime/memory-scaling";
import type { SandboxBackend, SandboxBox } from "@/lib/runtime/sandbox/backend";

const GIB = 1024 ** 3;
const probe = (gb = 4, used = 3.4, cache = 0) =>
  `memory.max\n${gb * GIB}\nmemory.current\n${Math.round(used * GIB)}\nmemory.stat\ninactive_file ${Math.round(cache * GIB)}\n`;

function box(output: string, memoryGb = 4) {
  const resized: number[] = [];
  const sandbox: SandboxBox = {
    id: "box", cpu: 2, memoryGb,
    io: { exec: async () => ({ stdout: output, exitCode: 0 }), launch: async () => assert.fail("no process launch"), upload: async () => {} },
    gitExec: async () => assert.fail("no git operation"),
    home: async () => "/home/runtime",
    agentEndpoint: async () => assert.fail("no agent restart"),
    growMemory: async (gb) => { resized.push(gb); },
  };
  return { sandbox, resized };
}

test("pressure readings use finite cgroup limits and subtract only reclaimable cache", () => {
  assert.deepEqual(memoryPressure(probe(4, 3, 1)), { limit: 4 * GIB, workingSet: 2 * GIB });
  for (const output of ["", probe().replace(String(4 * GIB), "max"), probe(0), probe(4, 1, 2), probe().replace("memory.current", "missing")]) {
    assert.equal(memoryPressure(output), null);
  }
});

test("pressure grows RAM one step without changing CPU, disk or restarting processes", async () => {
  const { sandbox, resized } = box(probe());
  assert.deepEqual(await growMemoryUnderPressure(sandbox, 16), { outcome: "scaled", memoryGb: 8 });
  assert.deepEqual(resized, [8]);
  assert.equal(sandbox.cpu, 2);
});

test("Free, Pro and Max cap automatic memory increases at their plan's allocation", async () => {
  for (const plan of Object.values(PLANS)) {
    const max = boxSize(plan.largestBoxSize).memoryGb;
    const { sandbox, resized } = box(probe(max, max * 0.95), max);
    assert.equal((await growMemoryUnderPressure(sandbox, max)).outcome, "at-limit");
    assert.deepEqual(resized, []);
  }
  const { sandbox, resized } = box(probe(1, 0.9), 1);
  await growMemoryUnderPressure(sandbox, 4);
  assert.deepEqual(resized, [2]);
});

test("quiet, cache-heavy, unreadable and unsupported boxes never grow", async () => {
  for (const output of [probe(4, 1), probe(4, 3.9, 2), ""]) {
    const { sandbox, resized } = box(output);
    await growMemoryUnderPressure(sandbox, 16);
    assert.deepEqual(resized, []);
  }
  const { sandbox } = box(probe());
  delete sandbox.growMemory;
  assert.equal((await growMemoryUnderPressure(sandbox, 16)).outcome, "unavailable");
});

test("a stale notification is measured again against the new allocation", async () => {
  const { sandbox, resized } = box(probe(8, 3.4), 8);
  assert.equal((await growMemoryUnderPressure(sandbox, 16)).outcome, "no-pressure");
  assert.deepEqual(resized, []);
});

test("a slow read cannot launch a resize after the lease's mutation window", async () => {
  const { sandbox, resized } = box(probe());
  assert.equal((await growMemoryUnderPressure(sandbox, 16, Date.now() - 1)).outcome, "unavailable");
  assert.deepEqual(resized, []);
});

test("provider allocation is also respected and resize failures are not reported as success", async () => {
  const { sandbox, resized } = box(probe(1, 0.9), 4);
  assert.equal((await growMemoryUnderPressure(sandbox, 4)).outcome, "at-limit");
  assert.deepEqual(resized, []);
  sandbox.growMemory = async () => { throw new Error("resizing not enabled"); };
  await assert.rejects(growMemoryUnderPressure(sandbox, 8), /not enabled/);
});

test("autoscaling a stopped computer does not fetch, resume or create it", async () => {
  const provider = new ComputerRuntimeProvider("daytona", {
    alive: async () => false,
    get: async () => assert.fail("do not fetch stopped boxes"),
    create: async () => assert.fail("do not create"),
    restore: async () => assert.fail("do not resume"),
  } as unknown as SandboxBackend);
  assert.equal((await provider.scaleComputerMemory("box", 16)).outcome, "unavailable");
});

const computer = { id: "computer", ownerId: "owner", orgId: "org", agentSecret: "agent-only-secret" };
function request(purpose: "memory-scale" | "media-upload" = "memory-scale", body = "{}") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { sandboxId: "box", timestamp, body,
    signature: mediaRequestSignature(computer.agentSecret, purpose, "box", timestamp, body) };
}
function deps(overrides: Partial<MemoryScaleDeps> = {}): MemoryScaleDeps {
  return {
    computer: async () => computer, isMember: async () => true, claim: async () => true,
    maxMemoryGb: async () => 8,
    grow: async (_c, _id, max) => { assert.equal(max, 8); return { outcome: "scaled", memoryGb: 8 }; },
    ...overrides,
  };
}

test("only the box's purpose-bound signature can ask for a check, never an arbitrary allocation", async () => {
  const denied = deps({ grow: async () => assert.fail("must not resize") });
  assert.equal((await requestMemoryScale(denied, { ...request(), signature: "wrong" })).status, 401);
  assert.equal((await requestMemoryScale(denied, { ...request(), timestamp: "1" })).status, 401);
  assert.equal((await requestMemoryScale(denied, request("media-upload"))).status, 401);
  assert.equal((await requestMemoryScale(denied, request("memory-scale", '{"memoryGb":64}'))).status, 400);
  assert.equal((await requestMemoryScale(deps({ computer: async () => null }), request())).status, 401);
  assert.equal((await requestMemoryScale(deps(), request())).body.outcome, "scaled");
});

test("membership, cooldown and replacement checks prevent unauthorized or duplicate scaling", async () => {
  const grow = async () => assert.fail("must not resize");
  assert.equal((await requestMemoryScale(deps({ grow, isMember: async () => false }), request())).status, 403);
  assert.equal((await requestMemoryScale(deps({ grow, claim: async () => false }), request())).body.outcome, "cooldown");
  let reads = 0;
  assert.equal((await requestMemoryScale(deps({ grow, computer: async () => ++reads === 1 ? computer : null }), request())).body.outcome, "unavailable");
  let claimed = false;
  let grows = 0;
  const shared = deps({
    claim: async () => { if (claimed) return false; claimed = true; return true; },
    grow: async () => { grows++; return { outcome: "scaled", memoryGb: 8 }; },
  });
  await Promise.all([requestMemoryScale(shared, request()), requestMemoryScale(shared, request())]);
  assert.equal(grows, 1);
});
