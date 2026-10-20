import assert from "node:assert/strict";
import { test } from "node:test";

import { DaytonaBackend } from "@/lib/runtime/sandbox/daytona";
import { IDLE_BACKSTOP_SECONDS } from "@/lib/runtime/sandbox/backend";
import { NeevBackend } from "@/lib/runtime/sandbox/neev";

/** A Daytona client that records what it's asked, around one box. */
function daytona(autoStopInterval: number) {
  const log: string[] = [];
  const sandbox = {
    id: "sb-1",
    cpu: 2,
    autoStopInterval,
    setAutostopInterval: async (minutes: number) => void log.push(`autostop ${minutes}`),
    refreshActivity: async () => void log.push("refresh"),
  };
  const client = {
    create: async (params: { autoStopInterval?: number; autoDeleteInterval?: number }) => {
      log.push(`create autostop ${params.autoStopInterval} autodelete ${params.autoDeleteInterval}`);
      return sandbox;
    },
    get: async () => sandbox,
  };
  return { client, log };
}

function withDaytona(backend: DaytonaBackend, client: unknown) {
  (backend as unknown as { client: unknown }).client = Promise.resolve(client);
  return backend;
}

test("Outrunner's Daytona boxes are made with a provider backstop that stops them if nothing renews it", async () => {
  const { client, log } = daytona(0);
  await withDaytona(new DaytonaBackend({ idleBackstop: true }), client).create({});
  assert.deepEqual(log, [`create autostop ${IDLE_BACKSTOP_SECONDS / 60} autodelete -1`]);
});

test("a user's own Daytona boxes keep running as before: nothing of ours renews them", async () => {
  const { client, log } = daytona(0);
  await withDaytona(new DaytonaBackend({ apiKey: async () => "k" }), client).create({});
  assert.deepEqual(log, ["create autostop 0 autodelete -1"]);
});

test("renewing a Daytona box from before the backstop arms it, then resets its timer", async () => {
  const { client, log } = daytona(0);
  await withDaytona(new DaytonaBackend({ idleBackstop: true }), client).keepAlive("sb-1");
  assert.deepEqual(log, [`autostop ${IDLE_BACKSTOP_SECONDS / 60}`, "refresh"]);
});

test("renewing an armed Daytona box only resets its timer", async () => {
  const { client, log } = daytona(IDLE_BACKSTOP_SECONDS / 60);
  await withDaytona(new DaytonaBackend({ idleBackstop: true }), client).keepAlive("sb-1");
  assert.deepEqual(log, ["refresh"]);
});

/** A Neev client that records what it's asked; its boxes never get ready, so
 *  a create stops right after the provider call. */
function neev(idleTimeoutSeconds: number) {
  const log: string[] = [];
  const sandbox = {
    id: "sb-1",
    data: { idle_timeout_seconds: idleTimeoutSeconds },
    waitUntilReady: async () => {
      throw new Error("stop here");
    },
    delete: async () => void log.push("delete"),
  };
  const client = {
    sandboxes: {
      create: async (params: { lifecycle?: Record<string, unknown> }) => {
        log.push(`create ${JSON.stringify(params.lifecycle)}`);
        return sandbox;
      },
      get: async () => sandbox,
      updateTimeout: async (_id: string, windows: Record<string, unknown>) => void log.push(`timeout ${JSON.stringify(windows)}`),
      keepalive: async () => void log.push("keepalive"),
    },
  };
  return { client, log };
}

function withNeev(backend: NeevBackend, client: unknown) {
  (backend as unknown as { client: unknown }).client = client;
  return backend;
}

test("Outrunner's Neev boxes pause, keeping their disk, if nothing renews them", async () => {
  const { client, log } = neev(0);
  await assert.rejects(withNeev(new NeevBackend({ idleBackstop: true }), client).create({}), /stop here/);
  const lifecycle = JSON.parse(log[0].slice("create ".length));
  assert.equal(lifecycle.idle_timeout_seconds, IDLE_BACKSTOP_SECONDS);
  assert.equal(lifecycle.on_idle, "pause");
  assert.equal(lifecycle.max_lifetime_seconds, 0);
});

test("renewing a Neev box from before the backstop arms it, then resets its timer", async () => {
  const { client, log } = neev(0);
  await withNeev(new NeevBackend({ idleBackstop: true }), client).keepAlive("sb-1");
  assert.deepEqual(log, [`timeout ${JSON.stringify({ idle_timeout_seconds: IDLE_BACKSTOP_SECONDS, on_idle: "pause" })}`, "keepalive"]);
});

test("renewing an armed Neev box only resets its timer", async () => {
  const { client, log } = neev(IDLE_BACKSTOP_SECONDS);
  await withNeev(new NeevBackend({ idleBackstop: true }), client).keepAlive("sb-1");
  assert.deepEqual(log, ["keepalive"]);
});
