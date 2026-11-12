import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { NotFoundError } from "@neevcloud/sdk";

import { CLAUDE_CODE_VERSION } from "@/lib/runtime/claude-cli";
import { asUserArgs } from "@/lib/runtime/sandbox/backend";
import {
  deploymentTag,
  IDLE_BACKSTOP_SECONDS,
  NEEV_LIFECYCLE,
  NeevBackend,
  neevBoxLabels,
  neevBoxName,
  neevPrepareScript,
  parseExecStream,
  SandboxRuntime,
} from "@/lib/runtime/sandbox/neev";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const b64 = (text: string) => Buffer.from(text).toString("base64");

test("an exec stream decodes its chunks and exit status", () => {
  const body = [
    JSON.stringify({ type: "stdout", data: b64("root ") }),
    JSON.stringify({ type: "stderr", data: b64("warn\n") }),
    JSON.stringify({ type: "stdout", data: b64("/root\n") }),
    JSON.stringify({ type: "exit", exit_code: 3 }),
    "",
  ].join("\n");
  assert.deepEqual(parseExecStream(body), { stdout: "root /root\n", stderr: "warn\n", exitCode: 3 });
});

test("an exec stream with no exit event is an error, not a success", () => {
  assert.throws(() => parseExecStream(JSON.stringify({ type: "stdout", data: b64("x") })), /without an exit/);
});

test("a secret reaches a command as the box user by name only", () => {
  const args = asUserArgs("git push", { GITHUB_TOKEN: "ghs_secret_value", OTHER: "v" });
  assert.deepEqual(args.slice(0, 2), ["-l", "runtime"]);
  assert.deepEqual(args.slice(2, 4), ["-w", "GITHUB_TOKEN,OTHER"]);
  assert.equal(args.join(" ").includes("ghs_secret_value"), false, "the value is in argv");
  assert.deepEqual(asUserArgs("id"), ["-l", "runtime", "-c", "id"]);
});

test("the box setup installs what the agent needs and makes its user", () => {
  const s = neevPrepareScript();
  for (const part of ["set -e", "apt-get update", "tmux", "jq", `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`, "@openai/codex@", "/bin/gh", "useradd -m"]) {
    assert.ok(s.includes(part), `setup lacks ${part}`);
  }
  assert.ok(s.indexOf("apt-get update") < s.indexOf("apt-get install"), "update before install");
  assert.equal(s.includes("sudo"), false, "Neev has no usable sudo; setup runs as root");
});

test("commands go to the sandbox on the project's API key", async () => {
  const seen: Array<{ url: string; auth: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      auth: (init.headers as Record<string, string>).authorization,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    });
    return new Response(JSON.stringify({ type: "exit", exit_code: 0 }) + "\n", { status: 200 });
  }) as typeof fetch;
  const runtime = new SandboxRuntime({ connectUrl: "https://box.example.test", apiKey: "sk-nc-test" });
  await runtime.exec("bash", ["-lc", "true"], { env: { A: "1" } });
  assert.equal(seen.length, 1, "one request: no token is minted first");
  assert.equal(seen[0].url, "https://box.example.test/v1/exec");
  assert.equal(seen[0].auth, "Bearer sk-nc-test");
  assert.deepEqual((seen[0].body as { env: string[] }).env, ["A=1"]);
});

test("a 401 says which key Neev needs", async () => {
  globalThis.fetch = (async () => new Response("invalid credentials", { status: 401 })) as typeof fetch;
  const runtime = new SandboxRuntime({ connectUrl: "https://box.example.test", apiKey: "pat-nc-personal" });
  await assert.rejects(runtime.exec("true", []), /HTTP 401[\s\S]*Resource Type "Sandboxes"/);
  await assert.rejects(runtime.write("/workspace/x", new Uint8Array([1])), /HTTP 401[\s\S]*sk-nc-/);
});

test("box setup runs in the background and is polled to its exit status", async () => {
  const { prepare } = await import("@/lib/runtime/sandbox/neev");
  const calls: string[] = [];
  let polls = 0;
  const runtime = {
    exec: async (_cmd: string, args: string[]) => {
      const line = args.join(" ");
      calls.push(line);
      if (line.includes("setsid")) return { stdout: "", stderr: "", exitCode: 0 };
      if (line.startsWith("-c cat")) return { stdout: ++polls < 3 ? "" : "0\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  await prepare(runtime, { pollMs: 1, sleep: async () => {} });
  assert.ok(calls[0].includes("setsid") && calls[0].endsWith("&"), "started detached, not held open");
  assert.equal(polls, 3, "polled until the exit file appeared");
});

test("a failed box setup reports its exit status and the log's tail", async () => {
  const { prepare } = await import("@/lib/runtime/sandbox/neev");
  const runtime = {
    exec: async (_cmd: string, args: string[]) => {
      const line = args.join(" ");
      if (line.startsWith("-c cat")) return { stdout: "100\n", stderr: "", exitCode: 0 };
      if (line.startsWith("-c tail")) return { stdout: "E: Unable to locate package tmux\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  await assert.rejects(prepare(runtime, { pollMs: 1, sleep: async () => {} }), /exit 100.*Unable to locate package tmux/);
});

test("a box setup that never finishes times out", async () => {
  const { prepare } = await import("@/lib/runtime/sandbox/neev");
  const runtime = { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) };
  await assert.rejects(prepare(runtime, { timeoutMs: 5, pollMs: 1, sleep: async () => {} }), /did not finish/);
});

/** A Neev backend on a fake client: one box in `phase`, noting what's done
 *  to it in `log`. `storageReset`: the box comes back without its user. */
function backendWithBox(
  phase: string,
  opts: { readyFails?: boolean; gone?: boolean; storageReset?: boolean; crashReset?: boolean; backstopped?: boolean } = {},
) {
  const log: string[] = [];
  const sandbox = {
    id: "sb-1",
    phase,
    connectUrl: "https://sb-1.example.test",
    resources: { cpu: 4, memory_gb: 8 },
    lastCrash: opts.crashReset ? { reason: "OOMKilled", at: "2026-11-12T10:00:00Z", storage_reset: true } : null,
    data: opts.backstopped ? { idle_timeout_seconds: IDLE_BACKSTOP_SECONDS, on_idle: "pause" } : { idle_timeout_seconds: 0 },
    resume: async () => void log.push("resume"),
    refresh: async () => sandbox,
    waitUntilReady: async () => {
      if (opts.readyFails) throw new Error("never ready");
      log.push("ready");
    },
    updateTimeout: async (windows: unknown) => void log.push(`backstop ${JSON.stringify(windows)}`),
  };
  const client = {
    sandboxes: {
      get: async () => {
        if (opts.gone) throw new NotFoundError(404, undefined, undefined);
        return sandbox;
      },
      pause: async () => void log.push("pause"),
      delete: async () => void log.push("delete"),
    },
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ type: "exit", exit_code: opts.storageReset ? 1 : 0 }) + "\n")) as unknown as typeof fetch;
  const backend = new NeevBackend();
  (backend as unknown as { client: unknown }).client = client;
  return { backend, log };
}

/** `fn` with NEEV_API_KEY set, as restore reads it to reach the box. */
async function withKey<T>(fn: () => Promise<T>): Promise<T> {
  const savedKey = process.env.NEEV_API_KEY;
  process.env.NEEV_API_KEY = "sk-nc-test";
  try {
    return await fn();
  } finally {
    if (savedKey === undefined) delete process.env.NEEV_API_KEY;
    else process.env.NEEV_API_KEY = savedKey;
  }
}

test("a paused Neev box is resumed in place, at the size it was made, and given the idle backstop", () =>
  withKey(async () => {
    const { backend, log } = backendWithBox("Paused");
    const box = await backend.restore("sb-1");
    assert.equal(box?.id, "sb-1");
    assert.equal(box?.cpu, 4);
    assert.equal(box?.memoryGb, 8);
    assert.deepEqual(log, ["resume", "ready", `backstop {"idle_timeout_seconds":${IDLE_BACKSTOP_SECONDS},"on_idle":"pause"}`]);
    const already = backendWithBox("Paused", { backstopped: true });
    await already.backend.restore("sb-1");
    assert.deepEqual(already.log, ["resume", "ready"], "a box that has it isn't updated");
  }));

test("a resume that fails partway pauses the box again, rather than leave it running", async () => {
  const { backend, log } = backendWithBox("Paused", { readyFails: true });
  await assert.rejects(backend.restore("sb-1"), /never ready/);
  assert.deepEqual(log, ["resume", "pause"]);
});

test("a box that's gone or lost its state is replaced: restore gives null", async () => {
  assert.equal(await backendWithBox("Paused", { gone: true }).backend.restore("sb-1"), null);
  assert.equal(await backendWithBox("RestoreFailed").backend.restore("sb-1"), null);
});

test("a box restarting after a crash is waited for and kept, with the session's files on it", () =>
  withKey(async () => {
    const crashed = backendWithBox("NotReady", { backstopped: true });
    assert.equal((await crashed.backend.restore("sb-1"))?.id, "sb-1");
    assert.deepEqual(crashed.log, ["ready"], "not resumed, paused or replaced");
    // One that doesn't come back in time is replaced, and paused: never left
    // to come back later running with no row naming it.
    const stuck = backendWithBox("NotReady", { readyFails: true });
    assert.equal(await stuck.backend.restore("sb-1"), null);
    assert.deepEqual(stuck.log, ["pause"]);
  }));

test("a box Neev says came back with its storage reset is deleted and replaced", () =>
  withKey(async () => {
    const { backend, log } = backendWithBox("Paused", { storageReset: true, crashReset: true });
    assert.equal(await backend.restore("sb-1"), null);
    assert.deepEqual(log, ["resume", "ready", "delete"]);
  }));

test("a box whose user can't be found, without Neev saying its storage was reset, is only paused", () =>
  withKey(async () => {
    const { backend, log } = backendWithBox("Paused", { storageReset: true });
    assert.equal(await backend.restore("sb-1"), null);
    assert.deepEqual(log, ["resume", "ready", "pause"], "its disk is kept: never deleted on one probe");
  }));

test("a box still pausing is a failure to retry, never a new box that leaves its files behind", async () => {
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => realTimeout(fn, 0)) as typeof setTimeout;
  try {
    const { backend, log } = backendWithBox("Pausing");
    await assert.rejects(backend.restore("sb-1"), /still pausing/);
    assert.deepEqual(log, []);
  } finally {
    globalThis.setTimeout = realTimeout;
  }
});

test("the reconciler's heartbeat resets Neev's idle timer", async () => {
  const seen: string[] = [];
  const backend = new NeevBackend();
  (backend as unknown as { client: unknown }).client = { sandboxes: { keepalive: async (id: string) => void seen.push(id) } };
  await backend.keepAlive("sb-9");
  assert.deepEqual(seen, ["sb-9"]);
});

test("a box's name carries its role, engine and deployment, which the orphan sweep reads back", () => {
  const name = neevBoxName({ "runtime.role": "computer", "runtime.engine": "claude", "runtime.deployment": "app.example.com" });
  assert.match(name, /^outrunner-claude-[0-9a-f]{8}-[0-9a-f]{8}$/);
  assert.ok(name.length <= 63, "a DNS name");
  assert.ok(name.includes(deploymentTag("app.example.com")));
  assert.deepEqual(neevBoxLabels(name, "app.example.com"), {
    "runtime.role": "computer",
    "runtime.engine": "claude",
    "runtime.deployment": "app.example.com",
  });
  // Another deployment's box (staging on the same project) never reads as ours.
  assert.notEqual(neevBoxLabels(name, "staging.example.com")?.["runtime.deployment"], "staging.example.com");
  // One from before tags has no deployment: only ever held by the sweep.
  assert.deepEqual(neevBoxLabels("outrunner-claude-1a2b3c4d", "app.example.com"), {
    "runtime.role": "computer",
    "runtime.engine": "claude",
  });
  // Anything not Outrunner's isn't listed at all.
  assert.equal(neevBoxLabels("my-sandbox", "app.example.com"), null);
  assert.equal(neevBoxLabels("sandbox-x1y2z3", "app.example.com"), null);
  // No deployment name: the old shape.
  assert.match(neevBoxName({ "runtime.engine": "claude" }), /^outrunner-claude-[0-9a-f]{8}$/);
});

test("new boxes are made with Neev's idle pause as a backstop, never deleted while running", () => {
  assert.equal(NEEV_LIFECYCLE.on_idle, "pause");
  assert.equal(NEEV_LIFECYCLE.idle_timeout_seconds, 4 * 60 * 60);
  assert.equal(NEEV_LIFECYCLE.max_lifetime_seconds, 0);
});

test("a personal access token is refused before any box is made, and still manages boxes running", async () => {
  const { isNeevPersonalToken } = await import("@/lib/runtime/sandbox/neev");
  assert.equal(isNeevPersonalToken("pat-nc-abc"), true);
  assert.equal(isNeevPersonalToken("sk-nc-abc"), false);
  assert.equal(isNeevPersonalToken(undefined), false);
  const saved = { key: process.env.NEEV_API_KEY, org: process.env.NEEV_ORG_ID, project: process.env.NEEV_PROJECT_ID };
  Object.assign(process.env, { NEEV_API_KEY: "pat-nc-personal", NEEV_ORG_ID: "org", NEEV_PROJECT_ID: "proj" });
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response("{}");
  }) as unknown as typeof fetch;
  try {
    await assert.rejects(new NeevBackend().create({}), /personal access token[\s\S]*sk-nc-/);
    assert.equal(fetched, false, "Neev was never called: no box to make and delete");
    // Managing boxes already running still works on it.
    const backend = new NeevBackend();
    const done: string[] = [];
    (backend as unknown as { client: unknown }).client = {
      sandboxes: {
        pause: async () => void done.push("pause"),
        keepalive: async () => void done.push("keepalive"),
        delete: async () => void done.push("delete"),
      },
    };
    await backend.pause("sb-1");
    await backend.keepAlive("sb-1");
    await backend.delete("sb-1");
    assert.deepEqual(done, ["pause", "keepalive", "delete"]);
  } finally {
    for (const [name, value] of [["NEEV_API_KEY", saved.key], ["NEEV_ORG_ID", saved.org], ["NEEV_PROJECT_ID", saved.project]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
