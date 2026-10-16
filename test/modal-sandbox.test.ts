import assert from "node:assert/strict";
import { test } from "node:test";

import { InvalidError, NotFoundError, SnapshotCreationError, TimeoutError } from "modal";

import { AGENT_PORT } from "@/lib/runtime/daytona/deploy";
import { box, MODAL_IMAGE_SETUP, noSnapshot, sandboxParams } from "@/lib/runtime/sandbox/modal";

test("a box lives as long as Modal allows, opens the agent's port, and leaves a snapshot when it ends", () => {
  const params = sandboxParams({ "runtime.role": "computer" }, { cpu: 4, memoryGb: 8 });
  assert.equal(params.timeoutMs, 24 * 60 * 60 * 1000);
  assert.deepEqual(params.encryptedPorts, [AGENT_PORT]);
  assert.deepEqual(params.experimentalOptions, { enable_exit_snapshot: true });
  // Kept up by its own command, not ended when the image's default one exits.
  assert.deepEqual(params.command, ["sleep", "infinity"]);
  assert.deepEqual(params.tags, { "runtime.role": "computer" });
  assert.equal(params.cpu, 4);
  assert.equal(params.memoryMiB, 8 * 1024);
});

test("a box with no size asked for gets Outrunner's default, not Modal's eighth of a CPU", () => {
  const params = sandboxParams({});
  assert.equal(params.cpu, 2);
  assert.equal(params.memoryMiB, 4 * 1024);
});

test("the image has what the agent needs, and the user Claude runs as", () => {
  const setup = MODAL_IMAGE_SETUP.join("\n");
  for (const part of ["tmux", "jq", "useradd -m", "claude.ai/install.sh"]) {
    assert.ok(setup.includes(part), `the image lacks ${part}`);
  }
  // Installed by the box user, so Claude Code can update itself.
  assert.match(setup, /su - runtime -c '[^']*install\.sh/);
});

test("only a missing, never-taken or failed snapshot means there's no disk to restore", () => {
  assert.equal(noSnapshot(new NotFoundError("gone")), true);
  assert.equal(noSnapshot(new InvalidError("exit snapshots not enabled")), true);
  assert.equal(noSnapshot(new SnapshotCreationError("failed")), true);
  // Not yet known: worth trying again rather than starting over.
  assert.equal(noSnapshot(new TimeoutError("still pending")), false);
  assert.equal(noSnapshot(new Error("network")), false);
});

/** A sandbox that records each exec and write, every command succeeding. */
function recordingSandbox() {
  const execs: { argv: string[]; env?: Record<string, string> }[] = [];
  const writes: { bytes: number; path: string }[] = [];
  const done = (text = "") => ({ readText: async () => text });
  const sandbox = {
    sandboxId: "sb-test",
    exec: async (argv: string[], params?: { env?: Record<string, string> }) => {
      execs.push({ argv, env: params?.env });
      return { stdout: done(), stderr: done(), wait: async () => 0 };
    },
    filesystem: {
      writeBytes: async (data: Buffer, path: string) => {
        writes.push({ bytes: data.length, path });
      },
    },
  };
  return { sandbox: sandbox as unknown as Parameters<typeof box>[0], execs, writes };
}

test("a large file reaches a box by download from the stash, checked by its hash", async () => {
  const { sandbox, execs, writes } = recordingSandbox();
  const stashed: number[] = [];
  const stash = async (data: Buffer) => {
    stashed.push(data.length);
    return { url: "https://storage.example.test/signed?token=secret-token", sha256: "ab".repeat(32) };
  };

  await box(sandbox, stash).io.upload(Buffer.alloc(3_500_000), "/home/runtime/runtime-agent.gz");

  assert.deepEqual(stashed, [3_500_000]);
  assert.equal(writes.length, 0, "nothing pushed through the write stream");
  const [download, move] = execs;
  assert.match(download.argv.join(" "), /curl .*"\$OUTRUNNER_UPLOAD_URL".*sha256sum -c/);
  assert.equal(download.env?.OUTRUNNER_UPLOAD_URL, "https://storage.example.test/signed?token=secret-token");
  assert.ok(!download.argv.join(" ").includes("secret-token"), "the signed URL is on the command line");
  assert.match(move.argv.join(" "), /install -D -o runtime -g runtime .* '\/home\/runtime\/runtime-agent\.gz'/);
});

test("a small file, or any without a stash, is written straight in", async () => {
  const small = recordingSandbox();
  await box(small.sandbox, async () => assert.fail("a small file was stashed")).io.upload(Buffer.from("{}"), "/home/runtime/a.json");
  assert.equal(small.writes.length, 1);

  const unstashed = recordingSandbox();
  await box(unstashed.sandbox, undefined).io.upload(Buffer.alloc(3_500_000), "/home/runtime/runtime-agent.gz");
  assert.deepEqual(unstashed.writes.map((w) => w.bytes), [3_500_000]);
});

