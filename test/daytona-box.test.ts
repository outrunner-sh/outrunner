import assert from "node:assert/strict";
import { test } from "node:test";

import type { Sandbox } from "@daytonaio/sdk";

import { box, daytonaSnapshotFor, EXEC_TIMEOUT_SECONDS, relabel } from "@/lib/runtime/sandbox/daytona";

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
