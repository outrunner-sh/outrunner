import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NO_READING,
  readSessionInfo,
  resourceReading,
  visibleSessionInfo,
  type InfoDependencies,
} from "@/lib/session/session-info";
import type { RuntimeComputer, Workspace } from "@/lib/runtime/types";

const workspace = {
  id: "session",
  provider: "daytona",
  status: "ready",
  environmentId: "project",
} as Workspace;
const computer = {
  status: "ready",
  daytonaSandboxId: "box",
  imageVersion: "runtime-v1",
} as RuntimeComputer;
function dependencies(over: Partial<InfoDependencies> = {}): InfoDependencies {
  return {
    computer: async () => computer,
    environment: async () => "Project",
    inspect: async () => NO_READING,
    ...over,
  };
}

test("resource snapshots distinguish allocations, measured values and unsupported metrics", () => {
  const reading = resourceReading(
    "memory.max\n8589934592\nmemory.current\n1073741824\ncpu.stat\nusage_usec 12340000\nuser_usec 1\ndisk\n 21474836480 3221225472\n",
    4,
  );
  assert.deepEqual(reading.cpu, { allocated: 4, used: 12.34 });
  assert.deepEqual(reading.memory, {
    allocated: 8 * 1024 ** 3,
    used: 1024 ** 3,
  });
  assert.deepEqual(reading.disk, {
    allocated: 20 * 1024 ** 3,
    used: 3 * 1024 ** 3,
  });
  assert.ok(reading.sampledAt);
  const missing = resourceReading(
    "memory.max\nmax\nmemory.current\nnot-a-number\n",
    undefined,
    2,
  );
  assert.deepEqual(missing.memory, { allocated: 2 * 1024 ** 3, used: null });
  assert.deepEqual(missing.cpu, { allocated: null, used: null });
  assert.deepEqual(resourceReading("", NaN, Infinity).disk, {
    allocated: null,
    used: null,
  });
  assert.equal(resourceReading("memory.current\n0\n").memory.used, 0);
});

test("paused and archived sessions never inspect, attach or wake a computer", async () => {
  const inspect = async () => {
    assert.fail("must not contact paused computers");
  };
  const stopped = await readSessionInfo(
    workspace,
    dependencies({
      computer: async () => ({ ...computer, status: "stopped" }),
      inspect,
    }),
  );
  assert.equal(stopped.state, "paused");
  assert.equal(stopped.sampledAt, null);
  assert.equal(stopped.runtimeVersion, "runtime-v1");
  const archived = await readSessionInfo(
    { ...workspace, status: "archived" },
    dependencies({ inspect }),
  );
  assert.equal(archived.state, "paused");
});

test("missing, failed and unreachable computers are unavailable, never fabricated as running", async () => {
  for (const value of [null, { ...computer, status: "error" as const }]) {
    const info = await readSessionInfo(
      workspace,
      dependencies({
        computer: async () => value,
        inspect: async () => {
          assert.fail();
        },
      }),
    );
    assert.equal(info.state, "unavailable");
    assert.equal(info.cpu.used, null);
  }
  const unreachable = await readSessionInfo(
    workspace,
    dependencies({
      inspect: async () => {
        throw new Error("secret upstream details");
      },
    }),
  );
  assert.equal(unreachable.state, "unavailable");
  assert.ok(!JSON.stringify(unreachable).includes("secret"));
  const running = await readSessionInfo(workspace, dependencies());
  assert.equal(running.state, "running");
});

test("signed-out and invisible/cross-org sessions cannot read computers or project details", async () => {
  const denied = dependencies({
    computer: async () => {
      assert.fail("not authorized");
    },
    environment: async () => {
      assert.fail("not authorized");
    },
    inspect: async () => {
      assert.fail("not authorized");
    },
  });
  assert.deepEqual(
    await visibleSessionInfo("hidden", {
      ...denied,
      signedIn: async () => false,
      visibleWorkspace: async () => {
        assert.fail("not signed in");
      },
    }),
    { status: 401 },
  );
  assert.deepEqual(
    await visibleSessionInfo("other-org", {
      ...denied,
      signedIn: async () => true,
      visibleWorkspace: async () => null,
    }),
    { status: 404 },
  );
});
