import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { Sandbox } from "@daytonaio/sdk";

import { NOVNC_PORT } from "@/lib/runtime/box-ports";
import { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import type { SandboxBackend, SandboxBox } from "@/lib/runtime/sandbox/backend";
import { box } from "@/lib/runtime/sandbox/daytona";
import { hasDesktop } from "@/lib/runtime/types";

/** A Daytona sandbox that records its computer-use starts and signed links. */
function desktopSandbox(): { sandbox: Sandbox; log: string[] } {
  const log: string[] = [];
  const sandbox = {
    id: "box-1",
    computerUse: {
      start: async () => {
        log.push("start");
        return { message: "started" };
      },
    },
    getSignedPreviewUrl: async (port: number, ttl: number) => {
      log.push(`signed ${port} ${ttl}`);
      return { url: `https://${port}-tok3n.daytonaproxy01.net`, token: "tok3n", port };
    },
  } as unknown as Sandbox;
  return { sandbox, log };
}

test("a Daytona box's desktop starts through computer use, and is viewed through noVNC's socket alone", async () => {
  const { sandbox, log } = desktopSandbox();
  const desktop = box(sandbox).desktop;
  assert.ok(desktop);
  await desktop.start();
  const url = await desktop.viewerUrl(120);
  assert.deepEqual(log, ["start", `signed ${NOVNC_PORT} 120`]);
  assert.equal(url, `wss://${NOVNC_PORT}-tok3n.daytonaproxy01.net/websockify`);
});

/** A backend whose one box is `b`. */
function backendOf(b: SandboxBox): SandboxBackend {
  return {
    create: async () => b,
    get: async () => b,
    alive: async () => true,
    delete: async () => {},
  };
}

test("opening a desktop starts it first, then links to it", async () => {
  const { sandbox, log } = desktopSandbox();
  const provider = new ComputerRuntimeProvider("daytona", backendOf(box(sandbox)));
  assert.equal(await provider.openDesktop("box-1", 60), `wss://${NOVNC_PORT}-tok3n.daytonaproxy01.net/websockify`);
  assert.deepEqual(log, ["start", `signed ${NOVNC_PORT} 60`]);
});

test("a box with no desktop says so, starting nothing", async () => {
  const noDesktop = { id: "box-2" } as unknown as SandboxBox;
  const provider = new ComputerRuntimeProvider("neev", backendOf(noDesktop));
  assert.equal(await provider.openDesktop("box-2", 60), null);
});

test("only Daytona sessions offer a desktop", () => {
  assert.equal(hasDesktop("daytona"), true);
  assert.equal(hasDesktop("user-daytona"), true);
  for (const provider of ["neev", "modal", "user-modal", "local"] as const) assert.equal(hasDesktop(provider), false);
});

test("a desktop start that hangs is given up after 30 seconds, not the SDK's five minutes", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const sandbox = { id: "box-1", computerUse: { start: () => new Promise(() => {}) } } as unknown as Sandbox;
    const started = box(sandbox).desktop!.start();
    const outcome = started.then(
      () => "started",
      (error: Error) => error.message,
    );
    let settled: string | undefined;
    void outcome.then((value) => (settled = value));
    mock.timers.tick(29_999);
    await Promise.resolve();
    assert.equal(settled, undefined);
    mock.timers.tick(1);
    assert.equal(await outcome, "Daytona's desktop didn't start in time (30 s)");
  } finally {
    mock.timers.reset();
  }
});
