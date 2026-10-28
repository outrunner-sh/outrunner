import assert from "node:assert/strict";
import { test } from "node:test";

import type { Sandbox } from "@daytonaio/sdk";

import { box, EXEC_TIMEOUT_SECONDS } from "@/lib/runtime/sandbox/daytona";

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
