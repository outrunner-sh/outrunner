import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import type { BoxIO } from "@/lib/runtime/daytona/deploy";
import type { SandboxBackend, SandboxBox } from "@/lib/runtime/sandbox/backend";

// The agent binary each provision uploads.
const dir = mkdtempSync(path.join(os.tmpdir(), "outrunner-agent-"));
const savedBinary = process.env.RUNTIME_AGENT_BINARY_PATH;
before(() => {
  writeFileSync(path.join(dir, "runtime-agent"), "agent");
  process.env.RUNTIME_AGENT_BINARY_PATH = path.join(dir, "runtime-agent");
});
after(() => {
  if (savedBinary === undefined) delete process.env.RUNTIME_AGENT_BINARY_PATH;
  else process.env.RUNTIME_AGENT_BINARY_PATH = savedBinary;
  rmSync(dir, { recursive: true, force: true });
});

/** A box whose agent comes up at once, noting in `log` what it was asked. */
function fakeBox(id: string, log: string[], opts: { launchFails?: boolean } = {}): SandboxBox {
  const io: BoxIO = {
    exec: async (command) => ({ stdout: command.includes("http_code") ? "200" : "", exitCode: 0 }),
    launch: async () => {
      log.push(`${id}: agent launched`);
      if (opts.launchFails) throw new Error("launch failed");
    },
    upload: async () => {},
  };
  return {
    id,
    io,
    gitExec: async (argv) => {
      if (argv.includes("init")) log.push(`${id}: mirror cloned`);
      if (argv.includes("--prune")) log.push(`${id}: mirror fetched`);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    home: async () => "/home/runtime",
    agentEndpoint: async () => ({
      controlBaseUrl: `https://${id}.example.test`,
      controlHeaders: {},
      wsBaseUrl: `https://${id}.example.test`,
    }),
  };
}

/** A backend whose ended boxes come back as `restoresTo` (null: no disk). */
function restoringBackend(log: string[], restoresTo: SandboxBox | null): SandboxBackend {
  return {
    pause: async (id) => {
      log.push(`${id}: paused`);
    },
    create: async () => {
      log.push("created");
      return fakeBox("sb-new", log);
    },
    restore: async (id) => {
      log.push(`restored from ${id}`);
      return restoresTo;
    },
    get: async (id) => fakeBox(id, log),
    alive: async () => true,
    delete: async (id) => {
      log.push(`${id}: deleted`);
    },
  };
}

const request = { secret: "s3cret", repoFullName: "acme/app", previousSandboxId: "sb-ended" };

test("a box that ended comes back on its disk: the agent starts again, and the mirror there catches up", async () => {
  const log: string[] = [];
  const provider = new ComputerRuntimeProvider("user-modal", restoringBackend(log, fakeBox("sb-back", log)));
  assert.equal(provider.restoresBoxes, true);

  const made = await provider.provisionComputer(request);

  assert.equal(made.sandboxId, "sb-back");
  assert.equal(made.agentBaseUrl, "https://sb-back.example.test");
  assert.deepEqual(log, ["restored from sb-ended", "sb-back: agent launched", "sb-back: mirror fetched"]);
  assert.deepEqual(
    made.timings.stages.map((s) => s.stage),
    ["sandbox_restore", "agent_boot", "mirror_fetch"],
  );
});

test("with the ended box's disk gone, the project gets a new box and a new mirror", async () => {
  const log: string[] = [];
  const provider = new ComputerRuntimeProvider("user-modal", restoringBackend(log, null));

  const made = await provider.provisionComputer(request);

  assert.equal(made.sandboxId, "sb-new");
  assert.deepEqual(log, ["restored from sb-ended", "created", "sb-new: agent launched", "sb-new: mirror cloned"]);
});

test("a restored box whose agent doesn't start is deleted, and the ended one kept", async () => {
  const log: string[] = [];
  const provider = new ComputerRuntimeProvider(
    "user-modal",
    restoringBackend(log, fakeBox("sb-back", log, { launchFails: true })),
  );

  await assert.rejects(() => provider.provisionComputer(request), /launch failed/);
  assert.deepEqual(log, ["restored from sb-ended", "sb-back: agent launched", "sb-back: deleted"]);
});

test("a paused box resumed in place that doesn't come up is paused again, never deleted", async () => {
  const log: string[] = [];
  // Neev and Daytona resume the same box: it is the only copy of its sessions.
  const provider = new ComputerRuntimeProvider(
    "neev",
    restoringBackend(log, fakeBox("sb-ended", log, { launchFails: true })),
  );

  await assert.rejects(() => provider.provisionComputer(request), /launch failed/);
  assert.deepEqual(log, ["restored from sb-ended", "sb-ended: agent launched", "sb-ended: paused"]);
});

test("a provider whose boxes don't end makes a new one, whatever came before", async () => {
  const log: string[] = [];
  const backend = restoringBackend(log, fakeBox("sb-back", log));
  const alwaysOn: SandboxBackend = {
    create: backend.create,
    get: backend.get,
    alive: backend.alive,
    delete: backend.delete,
  };
  const provider = new ComputerRuntimeProvider("neev", alwaysOn);
  assert.equal(provider.restoresBoxes, false);

  const made = await provider.provisionComputer(request);

  assert.equal(made.sandboxId, "sb-new");
  assert.deepEqual(log, ["created", "sb-new: agent launched", "sb-new: mirror cloned"]);
});

test("a running box's agent is upgraded in place, once however many ask at once", async () => {
  const log: string[] = [];
  const commands: string[] = [];
  const backend = restoringBackend(log, null);
  backend.get = async (id) => {
    const box = fakeBox(id, log);
    const exec = box.io.exec;
    box.io.exec = async (command) => {
      commands.push(command);
      return exec(command);
    };
    return box;
  };
  const provider = new ComputerRuntimeProvider("daytona", backend);
  await Promise.all([
    provider.upgradeAgent("sb-live", "s3cret", {}),
    provider.upgradeAgent("sb-live", "s3cret", {}),
  ]);
  // The same box, not a new one: its tools (Codex) installed, its agent
  // stopped and launched again.
  assert.deepEqual(log, ["sb-live: agent launched"]);
  assert.ok(commands.some((c) => c.includes("@openai/codex@")), "Codex installed");
  assert.ok(commands.some((c) => c.includes("pkill -x runtime-agent")), "the old agent stopped first");
  // Done, a later ask upgrades again.
  await provider.upgradeAgent("sb-live", "s3cret", {});
  assert.equal(log.length, 2);
});
