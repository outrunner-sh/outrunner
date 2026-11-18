import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { CommandExitError, NotFoundError, Sandbox } from "e2b";

import { shellQuote } from "@/lib/runtime/daytona/deploy";
import { box, BOX_TIMEOUT_MS, E2bBackend, EXEC_TIMEOUT_MS, forgetE2bHandles, guestMtu } from "@/lib/runtime/sandbox/e2b";
import { E2B_RELAY_PREFIX, openRelayTicket, relayKey, relayTicketValid } from "@/lib/runtime/sandbox/relay-ticket";

const ENV = {
  E2B_API_KEY: "e2b_test",
  E2B_API_URL: "http://e2b.internal:3000",
  E2B_SANDBOX_URL: "http://e2b.internal:3002/",
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
  delete process.env.E2B_GUEST_MTU;
});

afterEach(() => {
  for (const key of Object.keys(ENV)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  delete process.env.E2B_GUEST_MTU;
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

test("E2B_GUEST_MTU is a sane whole number or nothing", () => {
  assert.equal(guestMtu(undefined), null);
  assert.equal(guestMtu(""), null);
  assert.equal(guestMtu("1460"), 1460);
  for (const bad of ["1460.5", "abc", "100", "10000", "1460; reboot"]) assert.throws(() => guestMtu(bad), /E2B_GUEST_MTU/);
});

test("commands run as the box user with a deadline, and a non-zero exit is a result, not a throw", async () => {
  const fake = fakeSandbox((command) =>
    command === "false"
      ? new CommandExitError({ stdout: "out", stderr: "err", exitCode: 3, error: "exit status 3" })
      : { stdout: "ok\n", stderr: "", exitCode: 0 },
  );
  const b = box(fake.sandbox, INFO);
  assert.deepEqual(await b.io.exec("true"), { stdout: "ok\n", exitCode: 0 });
  assert.deepEqual(await b.io.exec("false"), { stdout: "out", exitCode: 3 });
  for (const run of fake.runs) {
    assert.equal(run.opts.user, "runtime");
    assert.equal(run.opts.timeoutMs, EXEC_TIMEOUT_MS);
  }
  assert.equal(b.cpu, 2);
  assert.equal(b.memoryGb, 4);
});

test("git's credential rides in the environment, never the command line", async () => {
  const fake = fakeSandbox();
  await box(fake.sandbox, INFO).gitExec(["git", "push", "origin", "it's"], { env: { GIT_TOKEN: "secret" } });
  const [run] = fake.runs;
  assert.equal(run.command, `bash -lc ${shellQuote(["git", "push", "origin", "it's"].map(shellQuote).join(" "))}`);
  assert.doesNotMatch(run.command, /secret/);
  assert.deepEqual(run.opts.envs, { GIT_TOKEN: "secret" });
});

test("a launched daemon runs in the background with no deadline, and is let go", async () => {
  const fake = fakeSandbox();
  await box(fake.sandbox, INFO).io.launch("runtime-agent serve");
  assert.deepEqual(fake.runs[0].opts, { user: "runtime", background: true, timeoutMs: 0 });
  assert.equal(fake.disconnected(), 1);
});

test("uploads are written as the box user", async () => {
  const fake = fakeSandbox();
  await box(fake.sandbox, INFO).io.upload(Buffer.from("agent"), "/home/runtime/runtime-agent.gz");
  assert.equal(fake.writes[0].path, "/home/runtime/runtime-agent.gz");
  assert.deepEqual(Buffer.from(fake.writes[0].data).toString(), "agent");
  assert.deepEqual(fake.writes[0].opts, { user: "runtime" });
});

test("the agent is reached through E2B's proxy by header, and the browser through our relay", async () => {
  const b = box(fakeSandbox().sandbox, INFO);
  const endpoint = await b.agentEndpoint(8080);
  assert.equal(endpoint.controlBaseUrl, "http://e2b.internal:3002");
  assert.deepEqual(endpoint.controlHeaders, { "E2b-Sandbox-Id": "sbx-1", "E2b-Sandbox-Port": "8080" });

  const prefix = `https://app.example${E2B_RELAY_PREFIX}sbx-1/8080/`;
  assert.ok(endpoint.wsBaseUrl.startsWith(prefix), endpoint.wsBaseUrl);
  const ticket = endpoint.wsBaseUrl.slice(prefix.length);
  assert.equal(relayTicketValid(ticket, "sbx-1", 8080, relayKey("credentials-key", "e2b")), true);
  // Not a ticket another provider's relay takes.
  assert.equal(relayTicketValid(ticket, "sbx-1", 8080, relayKey("credentials-key", "gcp")), false);

  assert.deepEqual(await b.previewTarget!(3000), {
    baseUrl: "http://e2b.internal:3002",
    headers: { "E2b-Sandbox-Id": "sbx-1", "E2b-Sandbox-Port": "3000" },
    hostHeader: "upstream",
  });
});

test("a box's traffic token goes with every way in: control calls, previews, and sealed in the relay's ticket", async () => {
  const sandbox = Object.assign(fakeSandbox().sandbox, { trafficAccessToken: "tat-1" }) as Sandbox;
  const b = box(sandbox, INFO);
  const endpoint = await b.agentEndpoint(8080);
  assert.deepEqual(endpoint.controlHeaders, {
    "E2b-Sandbox-Id": "sbx-1",
    "E2b-Sandbox-Port": "8080",
    "e2b-traffic-access-token": "tat-1",
  });
  const prefix = `https://app.example${E2B_RELAY_PREFIX}sbx-1/8080/`;
  const ticket = endpoint.wsBaseUrl.slice(prefix.length);
  // The browser has the ticket, never the token in the clear.
  assert.ok(!endpoint.wsBaseUrl.includes("tat-1"));
  assert.deepEqual(openRelayTicket(ticket, "sbx-1", 8080, relayKey("credentials-key", "e2b")), { secret: "tat-1" });
  assert.equal(openRelayTicket(ticket, "sbx-1", 8080, relayKey("credentials-key", "gcp")), null);
  assert.equal((await b.previewTarget!(3000)).headers["e2b-traffic-access-token"], "tat-1");
});

test("get never resumes a paused box, and reuses its handle while the box keeps its start", async () => {
  let state = "paused";
  const calls = fakeE2b({ getInfo: () => info(state), connect: () => fakeSandbox().sandbox });
  const backend = new E2bBackend();

  await assert.rejects(backend.get("sbx-1"), /paused, not running/);
  assert.deepEqual(calls, ["getInfo"]);
  assert.equal(await backend.alive("sbx-1"), false);

  state = "running";
  calls.length = 0;
  await backend.get("sbx-1");
  await backend.get("sbx-1");
  // One connect, then one look per get: no timeout rewritten with hours left.
  assert.deepEqual(calls, ["getInfo", "connect", "getInfo", "getInfo"]);
});

test("a box paused between the look and the connect is paused again, not left running", async () => {
  let started = 1_000;
  const calls = fakeE2b({
    getInfo: () => info("running", started),
    // This connect resumed it: a resume is a new start, from now.
    connect: () => {
      started = Date.now();
      return fakeSandbox().sandbox;
    },
  });
  await assert.rejects(new E2bBackend().get("sbx-1"), /paused while being reached/);
  assert.deepEqual(calls, ["getInfo", "connect", "getInfo", "pause"]);
});

test("a box someone else restored just before the connect is left running", async () => {
  // Paused and restored by another server between the look and the
  // connect: a new start, but from before this connect began.
  const looks = [info("running", 1_000), info("running", Date.now() - 10_000)];
  const calls = fakeE2b({ getInfo: () => looks.shift(), connect: () => fakeSandbox().sandbox });
  await new E2bBackend().get("sbx-1");
  assert.deepEqual(calls, ["getInfo", "connect", "getInfo"]);
});

test("a restore in this server is never paused by a get running alongside it", async () => {
  let started = 1_000;
  let releaseRestore = () => {};
  const calls = fakeE2b({
    getInfo: () => info("running", started),
    connect: (...args: never[]) => {
      const opts = args[1] as { timeoutMs?: number };
      if (opts.timeoutMs === BOX_TIMEOUT_MS) {
        // The restore's connect: it resumed the box, and waits until the get
        // has looked and connected.
        started = Date.now();
        return new Promise((resolve) => { releaseRestore = () => resolve(fakeSandbox().sandbox); });
      }
      // The get's connect lands strictly after this get began: on its own,
      // a new start like that would be taken for the get's resume.
      started = Date.now() + 1_000;
      return fakeSandbox().sandbox;
    },
  });
  const backend = new E2bBackend();
  const restoring = backend.restore("sbx-1");
  await backend.get("sbx-1");
  releaseRestore();
  await restoring;
  assert.ok(!calls.includes("pause"), calls.join(","));
});

test("a restore here that finished while a get was connecting isn't paused by that get", async () => {
  let started = 1_000;
  const backend = new E2bBackend();
  const calls = fakeE2b({
    getInfo: () => info("running", started),
    connect: async (...args: never[]) => {
      const opts = args[1] as { timeoutMs?: number };
      if (opts.timeoutMs === BOX_TIMEOUT_MS) {
        // The restore's own connect: it resumes the box now.
        started = Date.now();
        return fakeSandbox().sandbox;
      }
      // The get's connect: paused and restored here, start to finish, meanwhile.
      await backend.restore("sbx-1");
      return fakeSandbox().sandbox;
    },
  });
  await backend.get("sbx-1");
  assert.ok(!calls.includes("pause"), calls.join(","));
});

test("a box deleted elsewhere drops its handle", async () => {
  let gone = false;
  const calls = fakeE2b({
    getInfo: () => {
      if (gone) throw new NotFoundError("sandbox not found");
      return info("running");
    },
    connect: () => fakeSandbox().sandbox,
  });
  const backend = new E2bBackend();
  await backend.get("sbx-1");
  gone = true;
  await assert.rejects(backend.get("sbx-1"), NotFoundError);
  gone = false;
  calls.length = 0;
  await backend.get("sbx-1");
  assert.deepEqual(calls, ["getInfo", "connect", "getInfo"]);
});

test("a box in use has its timeout pushed back out only once half of it is gone", async () => {
  let left = BOX_TIMEOUT_MS;
  const extended: unknown[] = [];
  fakeE2b({
    getInfo: () => info("running", 1_000, left),
    connect: () => fakeSandbox().sandbox,
    setTimeout: (...args: never[]) => extended.push(args[1]),
  });
  const backend = new E2bBackend();
  await backend.get("sbx-1");
  assert.deepEqual(extended, []);
  left = BOX_TIMEOUT_MS / 2 - 1;
  await backend.get("sbx-1");
  assert.deepEqual(extended, [BOX_TIMEOUT_MS]);
});

test("alive and restore treat a gone box as gone", async () => {
  const gone = () => {
    throw new NotFoundError("sandbox not found");
  };
  fakeE2b({ getInfo: gone, connect: gone });
  const backend = new E2bBackend();
  assert.equal(await backend.alive("gone"), false);
  assert.equal(await backend.restore("gone"), null);
});

test("a resumed box that can't be set up is paused again, keeping its sessions", async () => {
  process.env.E2B_GUEST_MTU = "1460";
  const calls = fakeE2b({ connect: () => fakeSandbox(() => new Error("guest unreachable")).sandbox });
  await assert.rejects(new E2bBackend().restore("sbx-1"), /guest unreachable/);
  assert.deepEqual(calls, ["connect", "pause"]);
});

test("without E2B_SANDBOX_URL no box is made, rather than one on E2B's cloud", async () => {
  delete process.env.E2B_SANDBOX_URL;
  const calls = fakeE2b({});
  await assert.rejects(new E2bBackend().create({}), /E2B_SANDBOX_URL/);
  assert.deepEqual(calls, []);
});

test("a new box gets the guest MTU as root, and is killed if it can't be set up", async () => {
  process.env.E2B_GUEST_MTU = "1460";
  let created: Record<string, unknown> = {};
  let fake = fakeSandbox();
  const calls = fakeE2b({
    create: (...args: never[]) => {
      created = args[1];
      return fake.sandbox;
    },
    getInfo: () => info("running"),
  });
  const backend = new E2bBackend();

  await backend.create({ role: "computer" });
  assert.deepEqual(created.metadata, { role: "computer" });
  assert.deepEqual(created.lifecycle, { onTimeout: "pause" });
  assert.equal(created.timeoutMs, BOX_TIMEOUT_MS);
  // Its ports aren't open to anyone who learns its id.
  assert.deepEqual(created.network, { allowPublicTraffic: false });
  assert.equal(fake.runs[0].command, "ip link set eth0 mtu 1460");
  assert.equal(fake.runs[0].opts.user, "root");
  assert.ok(!calls.includes("kill"));

  fake = fakeSandbox(() => new Error("guest unreachable"));
  await assert.rejects(backend.create({}), /guest unreachable/);
  assert.equal(calls.at(-1), "kill");
});
