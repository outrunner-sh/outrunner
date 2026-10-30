import assert from "node:assert/strict";
import { test } from "node:test";

import { DaytonaNotFoundError, type Daytona, type Sandbox } from "@daytonaio/sdk";

import { boxSize, DEFAULT_BOX_SIZE } from "@/lib/runtime/box-sizes";
import { box, createParams, DaytonaBackend, DESKTOP_RESOLUTION, daytonaSnapshotFor, EXEC_TIMEOUT_SECONDS, relabel, settled, SETTLE_TIMEOUT_SECONDS } from "@/lib/runtime/sandbox/daytona";

/** A sandbox whose executeCommand records the timeout it was given. */
function recording(): { sandbox: Sandbox; timeouts: (number | undefined)[] } {
  const timeouts: (number | undefined)[] = [];
  const sandbox = {
    id: "box-1",
    cpu: 2,
    process: {
      executeCommand: async (_command: string, _cwd?: string, _env?: Record<string, string>, timeout?: number) => {
        timeouts.push(timeout);
        return { result: "", exitCode: 0 };
      },
    },
  } as unknown as Sandbox;
  return { sandbox, timeouts };
}

test("hot memory resize sends only memory to Daytona and refuses stops or decreases", async () => {
  const calls: unknown[] = [];
  const sdk = { id: "box", state: "started", cpu: 2, memory: 4,
    resize: async (...args: unknown[]) => { calls.push(args); } } as unknown as Sandbox;
  await box(sdk).growMemory!(8);
  assert.deepEqual(calls, [[{ memory: 8 }, 60]]);
  await assert.rejects(box(sdk).growMemory!(4), /must increase/);
  sdk.state = "stopped" as Sandbox["state"];
  await assert.rejects(box(sdk).growMemory!(8), /running sandbox/);
  assert.equal(calls.length, 1);
});

test("a hot-resizing Daytona sandbox stays alive to the reconciler", async () => {
  const backend = new DaytonaBackend();
  let state = "resizing";
  (backend as unknown as { client: Promise<unknown> }).client = Promise.resolve({ get: async () => ({ state }) });
  assert.equal(await backend.alive("box"), true);
  state = "stopped";
  assert.equal(await backend.alive("box"), false);
});

test("every command on a box has a deadline, so a call Daytona never answers can't hang a setup", async () => {
  const { sandbox, timeouts } = recording();
  const b = box(sandbox);
  await b.io.exec("true");
  await b.gitExec(["git", "--version"]);
  assert.deepEqual(timeouts, [EXEC_TIMEOUT_SECONDS, EXEC_TIMEOUT_SECONDS]);
});

test("a box brought back gets the labels it lacks, keeping its others, and a failure doesn't stop it", async () => {
  const set: Record<string, string>[] = [];
  const labelled = (labels: Record<string, string>, fails = false) =>
    ({
      id: "box-1",
      labels,
      setLabels: async (next: Record<string, string>) => {
        set.push(next);
        if (fails) throw new Error("Daytona unavailable");
        return next;
      },
    }) as unknown as Sandbox;
  const wanted = { "runtime.role": "computer", "runtime.deployment": "outrunner.example" };

  await relabel(labelled({ "runtime.role": "computer", other: "kept" }), wanted);
  assert.deepEqual(set, [{ "runtime.role": "computer", other: "kept", "runtime.deployment": "outrunner.example" }]);

  // Already labelled: nothing to write.
  await relabel(labelled(wanted), wanted);
  assert.equal(set.length, 1);

  await relabel(labelled({}, true), wanted);
  assert.equal(set.length, 2);
});

test("a sized box is Daytona's largest size within both resources, the account default below them", () => {
  assert.equal(daytonaSnapshotFor({ cpu: 1, memoryGb: 2 }), undefined);
  assert.equal(daytonaSnapshotFor({ cpu: 2, memoryGb: 4 }), "daytona-medium");
  assert.equal(daytonaSnapshotFor({ cpu: 4, memoryGb: 8 }), "daytona-large");
  assert.equal(daytonaSnapshotFor({ cpu: 8, memoryGb: 16 }), "daytona-large");
});

test("snapshot selection respects memory as well as CPU, and never rounds CPU up", () => {
  assert.equal(daytonaSnapshotFor({ cpu: 4, memoryGb: 4 }), "daytona-medium");
  assert.equal(daytonaSnapshotFor({ cpu: 8, memoryGb: 2 }), undefined);
  assert.equal(daytonaSnapshotFor({ cpu: 3, memoryGb: 6 }), "daytona-medium");
  assert.equal(daytonaSnapshotFor({ cpu: 1, memoryGb: 8 }), undefined);
});

/** Inject only the SDK boundary, exercising the backend's actual create path. */
function creating(create: Daytona["create"]): DaytonaBackend {
  const backend = new DaytonaBackend();
  (backend as unknown as { client: Promise<Pick<Daytona, "create">> }).client = Promise.resolve({ create });
  return backend;
}

test("backend sends the selected Small default to the SDK, preserving labels, desktop and idle settings", async () => {
  const labels = { "runtime.role": "computer", "runtime.deployment": "test" };
  const backend = creating(async (params, options) => {
    assert.deepEqual(params, {
      snapshot: "daytona-medium", labels, autoStopInterval: 0, autoDeleteInterval: -1,
      envVars: { VNC_RESOLUTION: DESKTOP_RESOLUTION },
    });
    assert.deepEqual(options, { timeout: 180 });
    assert.equal("resources" in params!, false);
    assert.equal("image" in params!, false);
    return { id: "sized", cpu: 2, memory: 4 } as Sandbox;
  });
  const sandbox = await backend.create(labels, boxSize(DEFAULT_BOX_SIZE));
  assert.equal(sandbox.id, "sized");
  assert.equal(sandbox.cpu, 2);
});

test("unsized backend creates keep the account's default snapshot", async () => {
  const backend = creating(async (params) => {
    assert.equal("snapshot" in params!, false);
    return { id: "own-default", cpu: 1, memory: 1 } as Sandbox;
  });
  await backend.create({});
  assert.equal("snapshot" in createParams({}), false);
});

test("backend logs actual resources for capped Large and inexact X Small, preserving actual billing CPU", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  for (const [cpu, memory, size] of [
    [4, 8, { cpu: 8, memoryGb: 16 }],
    [1, 1, { cpu: 1, memoryGb: 2 }],
  ] as const) {
    const backend = creating(async () => ({ id: "capped", cpu, memory }) as Sandbox);
    const sandbox = await backend.create({}, size);
    assert.equal(sandbox.cpu, cpu);
    assert.match(String(warnings.mock.calls.at(-1)!.arguments[0]),
      new RegExp(`requested ${size.cpu} vCPU / ${size.memoryGb} GiB; received ${cpu} vCPU / ${memory} GiB`));
  }
  assert.equal(warnings.mock.callCount(), 2);
});

test("missing named snapshot retries only once using the account default and keeps all setup params", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  let calls = 0;
  const labels = { verify: "missing-snapshot" };
  const backend = creating(async (params, options) => {
    calls++;
    assert.deepEqual(options, { timeout: 180 });
    if (calls === 1) {
      assert.equal((params as { snapshot: string }).snapshot, "daytona-medium");
      throw new DaytonaNotFoundError("Snapshot daytona-medium not found");
    }
    assert.deepEqual(params, createParams(labels));
    return { id: "fallback", cpu: 1, memory: 1 } as Sandbox;
  });
  await backend.create(labels, { cpu: 2, memoryGb: 4 });
  assert.equal(calls, 2);
  assert.match(String(warnings.mock.calls[0].arguments[0]), /daytona-medium.*default snapshot/);
  assert.match(String(warnings.mock.calls[1].arguments[0]), /requested 2.*received 1/);
});

test("backend propagates auth, quota, timeout, unrelated not-found and default-snapshot failures", async (t) => {
  t.mock.method(console, "warn", () => {});
  for (const error of [new Error("Unauthorized"), new Error("Quota exceeded"), new Error("Timeout"),
    new DaytonaNotFoundError("Target not found")]) {
    let calls = 0;
    const backend = creating(async () => { calls++; throw error; });
    await assert.rejects(backend.create({}, { cpu: 2, memoryGb: 4 }), (e) => e === error);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const error = new DaytonaNotFoundError("Snapshot not found");
  const backend = creating(async () => { calls++; throw error; });
  await assert.rejects(backend.create({}, { cpu: 2, memoryGb: 4 }), (e) => e === error);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(backend.create({}), (e) => e === error);
  assert.equal(calls, 1);
});

/** A sandbox that reports `states` in turn, one per refresh. */
function going(states: string[]) {
  let at = 0;
  const sandbox = {
    id: "box-1",
    state: states[0],
    refreshData: async () => {
      at = Math.min(at + 1, states.length - 1);
      sandbox.state = states[at];
    },
  };
  return sandbox as unknown as Pick<Sandbox, "id" | "state" | "refreshData">;
}

test("a box still archiving is waited out, so it's started again rather than taken for gone", async () => {
  assert.equal(await settled(going(["archiving", "archiving", "archived"]), 5, 1), "archived");
  assert.equal(await settled(going(["stopping", "stopped"]), 5, 1), "stopped");
  // Settled already: answered as it is, without asking again.
  assert.equal(await settled(going(["started"]), 5, 1), "started");
  assert.equal(await settled(going(["destroyed"]), 5, 1), "destroyed");
});

test("a box that never finishes going down is an error to try again, not a new box", async () => {
  await assert.rejects(settled(going(["archiving"]), 0.01, 1), /box-1 is still archiving/);
});

test("the default settle wait fails in 30 seconds, within the lifecycle route's 60 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  assert.equal(SETTLE_TIMEOUT_SECONDS, 30);
  const rejected = assert.rejects(settled(going(["archiving"])), /box-1 is still archiving/);
  for (let elapsed = 0; elapsed < 30_000; elapsed += 2_000) {
    t.mock.timers.tick(2_000);
    await Promise.resolve();
    await Promise.resolve();
  }
  await rejected;
  assert.equal(Date.now(), 30_000);
});
