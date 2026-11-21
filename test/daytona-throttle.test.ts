import assert from "node:assert/strict";
import { test } from "node:test";

import { DaytonaNotFoundError, DaytonaRateLimitError, type Daytona, type Sandbox } from "@daytonaio/sdk";

import { AUTO_STOP_MINUTES, DaytonaBackend, THROTTLE_WAITS_MS, throttled, unthrottled } from "@/lib/runtime/sandbox/daytona";

/** What Daytona's API answered a session's setup on 2026-11-21. */
const throttle = () => new DaytonaRateLimitError("ThrottlerException: Too Many Requests", 429);

/** A sleep that only notes how long it was asked to wait. */
function noting(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
}

test("a throttle is Daytona's 429, however it reaches us; nothing else is", () => {
  assert.equal(throttled(throttle()), true);
  assert.equal(throttled({ statusCode: 429, message: "slow down" }), true);
  assert.equal(throttled(new Error("Setup failed: ThrottlerException: Too Many Requests")), true);
  // Not throttles: waiting won't help, so they fail as they did.
  assert.equal(throttled(new DaytonaNotFoundError("Sandbox not found", 404)), false);
  assert.equal(throttled(new Error("Total disk limit exceeded")), false);
  assert.equal(throttled(null), false);
  assert.equal(throttled("Too Many Requests"), false);
});

test("a throttled call is made again after a wait, and answers once Daytona lets it through", async () => {
  const { sleep, waits } = noting();
  let calls = 0;
  const answer = await unthrottled(
    async () => {
      calls += 1;
      if (calls <= 2) throw throttle();
      return "box-1";
    },
    "a new box",
    { sleep, random: () => 0.5 },
  );
  assert.equal(answer, "box-1");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2_000, 4_000]);
});

test("each wait is spread by up to a quarter, so boxes throttled together come back apart", async () => {
  for (const [random, first] of [[0, 1_500], [1, 2_500]] as const) {
    const { sleep, waits } = noting();
    let calls = 0;
    await unthrottled(async () => {
      if (calls++ === 0) throw throttle();
    }, "a new box", { sleep, random: () => random });
    assert.deepEqual(waits, [first]);
  }
});

test("a call throttled past the last wait fails as Daytona said, about 14 seconds on", async () => {
  const { sleep, waits } = noting();
  let calls = 0;
  await assert.rejects(
    unthrottled(async () => {
      calls += 1;
      throw throttle();
    }, "a new box", { sleep, random: () => 0.5 }),
    (error: unknown) => error instanceof DaytonaRateLimitError,
  );
  assert.equal(calls, THROTTLE_WAITS_MS.length + 1);
  assert.deepEqual(waits, [...THROTTLE_WAITS_MS]);
  assert.equal(waits.reduce((a, b) => a + b, 0), 14_000);
});

test("any other error fails at once, with no wait", async () => {
  const { sleep, waits } = noting();
  let calls = 0;
  await assert.rejects(
    unthrottled(async () => {
      calls += 1;
      throw new Error("Total disk limit exceeded");
    }, "a new box", { sleep }),
    /Total disk limit exceeded/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

/** A backend on a fake SDK client, its waits noted rather than slept. */
function backendOn(client: Partial<Daytona>): { backend: DaytonaBackend; waits: number[] } {
  const { sleep, waits } = noting();
  const backend = new DaytonaBackend({ sleep });
  (backend as unknown as { client: Promise<Partial<Daytona>> }).client = Promise.resolve(client);
  return { backend, waits };
}

test("a new box Daytona throttles is asked for again, not failed", async () => {
  let calls = 0;
  const { backend, waits } = backendOn({
    create: (async () => {
      calls += 1;
      if (calls === 1) throw throttle();
      return { id: "box-2", cpu: 2, memory: 4 } as Sandbox;
    }) as Daytona["create"],
  });
  const box = await backend.create({ "runtime.role": "computer" });
  assert.equal(box.id, "box-2");
  assert.equal(calls, 2);
  assert.equal(waits.length, 1);
});

test("a stopped box whose start Daytona throttles is started again, not stopped and failed", async () => {
  let starts = 0;
  let stops = 0;
  const sandbox = {
    id: "box-3",
    state: "stopped",
    labels: {},
    autoStopInterval: AUTO_STOP_MINUTES,
    start: async () => {
      starts += 1;
      if (starts === 1) throw throttle();
    },
    stop: async () => {
      stops += 1;
    },
  } as unknown as Sandbox;
  let gets = 0;
  const { backend, waits } = backendOn({
    get: (async () => {
      gets += 1;
      if (gets === 1) throw throttle();
      return sandbox;
    }) as Daytona["get"],
  });
  const box = await backend.restore("box-3");
  assert.equal(box?.id, "box-3");
  assert.deepEqual({ gets, starts, stops, waits: waits.length }, { gets: 2, starts: 2, stops: 0, waits: 2 });
});

test("a box gone is still gone at once: only a throttle is waited out", async () => {
  const { backend, waits } = backendOn({
    get: (async () => {
      throw new DaytonaNotFoundError("Sandbox not found", 404);
    }) as Daytona["get"],
  });
  assert.equal(await backend.restore("box-4"), null);
  assert.deepEqual(waits, []);
});
