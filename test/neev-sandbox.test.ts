import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  asUserArgs,
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
  for (const part of ["set -e", "apt-get update", "tmux", "jq", "@anthropic-ai/claude-code", "useradd -m"]) {
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
