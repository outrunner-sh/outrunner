import assert from "node:assert/strict";
import { test } from "node:test";

import type { Sandbox } from "@daytonaio/sdk";

import { box, daytonaSnapshotFor, EXEC_TIMEOUT_SECONDS, relabel, settled, SETTLE_TIMEOUT_SECONDS } from "@/lib/runtime/sandbox/daytona";

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

test("a sized box is Daytona's largest size within its vCPUs, the base box below them", () => {
  assert.equal(daytonaSnapshotFor({ cpu: 1, memoryGb: 2 }), undefined);
  assert.equal(daytonaSnapshotFor({ cpu: 2, memoryGb: 4 }), "daytona-medium");
  assert.equal(daytonaSnapshotFor({ cpu: 4, memoryGb: 8 }), "daytona-large");
  assert.equal(daytonaSnapshotFor({ cpu: 8, memoryGb: 16 }), "daytona-large");
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
