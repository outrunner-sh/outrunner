import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { Sandbox } from "e2b";

import { box, BOX_TIMEOUT_MS, E2bBackend, forgetE2bHandles } from "@/lib/runtime/sandbox/e2b";
import { relayKey, relayTicketValid, USER_E2B_RELAY_PREFIX } from "@/lib/runtime/sandbox/relay-ticket";
import { e2bUrl } from "@/lib/runtime/user-e2b-checks";
import {
  E2bTemplateNotReadyError,
  NoE2bKeyError,
  USER_BOX_TIMEOUT_MS,
  UserE2bRuntimeProvider,
  userE2bConnection,
} from "@/lib/runtime/user-e2b-provider";

const ENV = {
  OUTRUNNER_E2B_API_KEY: "e2b_test",
  OUTRUNNER_E2B_API_URL: "http://e2b.internal:3000",
  OUTRUNNER_E2B_SANDBOX_URL: "http://e2b.internal:3002/",
  CREDENTIALS_ENCRYPTION_KEY: "credentials-key",
  RUNTIME_BASE_URL: "https://app.example",
};
const saved: Record<string, string | undefined> = {};
const statics = {
  getInfo: Sandbox.getInfo,
  connect: Sandbox.connect,
  create: Sandbox.create,
  kill: Sandbox.kill,
  pause: Sandbox.pause,
  setTimeout: Sandbox.setTimeout,
};

beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  delete process.env.OUTRUNNER_E2B_GUEST_MTU;
});

afterEach(() => {
  for (const key of Object.keys(ENV)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  delete process.env.OUTRUNNER_E2B_GUEST_MTU;
  Object.assign(Sandbox, statics);
  forgetE2bHandles();
});

type Run = { command: string; opts: Record<string, unknown> };

/** A sandbox whose commands are recorded and answered by `answer`. */
function fakeSandbox(answer: (command: string) => unknown = () => ({ stdout: "", stderr: "", exitCode: 0 })) {
  const runs: Run[] = [];
  const writes: Array<{ path: string; data: Uint8Array; opts: unknown }> = [];
  let disconnected = 0;
  const sandbox = {
    sandboxId: "sbx-1",
    commands: {
      run: async (command: string, opts: Record<string, unknown> = {}) => {
        runs.push({ command, opts });
        if (opts.background) return { disconnect: async () => { disconnected += 1; } };
        const result = answer(command);
        if (result instanceof Error) throw result;
        return result;
      },
    },
    files: {
      write: async (path: string, data: Uint8Array, opts: unknown) => {
        writes.push({ path, data, opts });
      },
    },
  } as unknown as Sandbox;
  return { sandbox, runs, writes, disconnected: () => disconnected };
}

const INFO = { cpuCount: 2, memoryMB: 4096 };

/** What E2B says of box `sbx-1`: started at `startedAt`, its timeout `left` away. */
function info(state: string, startedAt = 1_000, left = BOX_TIMEOUT_MS) {
  return { ...INFO, sandboxId: "sbx-1", state, startedAt: new Date(startedAt), endAt: new Date(Date.now() + left) };
}

/** Stand in for E2B's static calls, recording which were made. */
function fakeE2b(overrides: Partial<Record<keyof typeof statics, (...args: never[]) => unknown>>) {
  const calls: string[] = [];
  const record = (name: keyof typeof statics) => async (...args: never[]) => {
    calls.push(name);
    return overrides[name]?.(...args);
  };
  Object.assign(Sandbox, Object.fromEntries(Object.keys(statics).map((name) => [name, record(name as keyof typeof statics)])));
  return calls;
}

const STORED = {
  apiKey: "e2b_user",
  apiUrl: null,
  sandboxUrl: null,
  template: "ready" as const,
  templateId: "tmpl-user",
  templateBuildId: "build-1",
  templateError: null,
};

test("a box in a user's E2B cloud is reached at its own host, browsers included", async () => {
  const sandbox = { ...fakeSandbox().sandbox, getHost: (port: number) => `${port}-sbx-1.e2b.app` } as unknown as Sandbox;
  const b = box(sandbox, INFO, userE2bConnection(STORED));
  const endpoint = await b.agentEndpoint(8080);
  assert.deepEqual(endpoint, {
    controlBaseUrl: "https://8080-sbx-1.e2b.app",
    controlHeaders: {},
    wsBaseUrl: "https://8080-sbx-1.e2b.app",
  });
  assert.deepEqual(await b.previewTarget!(3000), { baseUrl: "https://3000-sbx-1.e2b.app", headers: {}, hostHeader: "upstream" });
});

test("a box in a user's self-hosted E2B goes by header, browsers through the user-E2B relay", async () => {
  const c = userE2bConnection({ ...STORED, apiUrl: "https://e2b-api.example.com", sandboxUrl: "https://e2b-sbx.example.com" });
  const endpoint = await box(fakeSandbox().sandbox, INFO, c).agentEndpoint(8080);
  assert.equal(endpoint.controlBaseUrl, "https://e2b-sbx.example.com");
  assert.deepEqual(endpoint.controlHeaders, { "E2b-Sandbox-Id": "sbx-1", "E2b-Sandbox-Port": "8080" });
  const prefix = `https://app.example${USER_E2B_RELAY_PREFIX}sbx-1/8080/`;
  assert.ok(endpoint.wsBaseUrl.startsWith(prefix), endpoint.wsBaseUrl);
  const ticket = endpoint.wsBaseUrl.slice(prefix.length);
  assert.equal(relayTicketValid(ticket, "sbx-1", 8080, relayKey("credentials-key", "user-e2b")), true);
  // The deployment's E2B relay doesn't take it.
  assert.equal(relayTicketValid(ticket, "sbx-1", 8080, relayKey("credentials-key", "e2b")), false);
});

test("a user's box waits for their template, and is made on their key at E2B's cloud", async () => {
  let created: { template?: string; opts?: Record<string, unknown> } = {};
  const calls = fakeE2b({
    create: (...args: never[]) => {
      created = { template: args[0], opts: args[1] };
      return fakeSandbox().sandbox;
    },
    getInfo: () => info("running"),
  });

  const backendOf = (provider: UserE2bRuntimeProvider) => (provider as unknown as { backend: E2bBackend }).backend;
  for (const template of ["building", "failed", "outdated", "none"] as const) {
    const backend = backendOf(new UserE2bRuntimeProvider(async () => ({ ...STORED, template })));
    await assert.rejects(backend.create({}), E2bTemplateNotReadyError);
  }
  assert.deepEqual(calls, []);

  const backend = backendOf(new UserE2bRuntimeProvider(async () => STORED));
  await backend.create({});
  assert.equal(created.template, "tmpl-user");
  assert.equal(created.opts?.apiKey, "e2b_user");
  assert.equal(created.opts?.apiUrl, "https://api.e2b.app");
  assert.equal(created.opts?.domain, "e2b.app");
  assert.equal(created.opts?.sandboxUrl, undefined);
  assert.equal(created.opts?.timeoutMs, USER_BOX_TIMEOUT_MS);

  await assert.rejects(backendOf(new UserE2bRuntimeProvider(async () => null)).alive("sbx-1"), NoE2bKeyError);
});

test("a self-hosted E2B's URLs must be https origins on public hosts", () => {
  assert.equal(e2bUrl(""), null);
  assert.equal(e2bUrl(undefined), null);
  assert.equal(e2bUrl("https://e2b-api.example.com/"), "https://e2b-api.example.com");
  assert.equal(e2bUrl(" https://e2b-api.example.com "), "https://e2b-api.example.com");
  for (const bad of [
    "http://e2b-api.example.com",
    "https://10.0.0.5",
    "https://169.254.169.254",
    "https://127.0.0.1:3000",
    "https://localhost",
    "https://metadata.google.internal",
    "https://user:pass@e2b-api.example.com",
    "https://e2b-api.example.com/v1",
    "not a url",
  ]) {
    assert.equal(e2bUrl(bad), undefined, bad);
  }
});


test("a desktop in a user's E2B cloud is opened at its own host, with its password", async () => {
  const fake = fakeSandbox((command) =>
    command === "outrunner-desktop password 120" ? { stdout: "Ab3dEf7h\n", stderr: "", exitCode: 0 } : { stdout: "", stderr: "", exitCode: 0 },
  );
  const sandbox = { ...fake.sandbox, getHost: (port: number) => `${port}-sbx-1.e2b.app` } as unknown as Sandbox;
  assert.deepEqual(await box(sandbox, INFO, userE2bConnection(STORED)).desktop!.viewer(120), {
    url: "wss://6080-sbx-1.e2b.app/websockify",
    password: "Ab3dEf7h",
  });
});
