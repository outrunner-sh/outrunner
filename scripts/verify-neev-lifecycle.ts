/**
 * Does a Runtime Computer on Neev do what a session needs? Runs Outrunner's
 * own provisioning on a real box and times each step:
 *
 *   1. provision: create, prepare (tools, the box user), upload and boot the agent;
 *   2. the agent answers through the tunnel (health);
 *   3. a command runs as the box user, and writes a file;
 *   4. the orphaned-box sweep's listing finds the box, named as this deployment's;
 *   5. pause: the box stops (alive false, phase Paused);
 *   6. resume: the same box back, the agent booted again, the file still there;
 *   7. delete: the box is gone.
 *
 * The box is named `outrunner-smoketest-…` and is deleted at the end, even on
 * failure. Its deployment label is RUNTIME_BASE_URL's host (default
 * neev-smoke-test.invalid), never production's.
 *
 *   bash scripts/build-agent.sh
 *   node --experimental-strip-types --import ./scripts/test-loader.mjs scripts/verify-neev-lifecycle.ts
 *
 * Needs NEEV_API_KEY, NEEV_ORG_ID, NEEV_PROJECT_ID (optional NEEV_SANDBOX_TEMPLATE, NEEV_BASE_URL).
 */

import { randomBytes } from "node:crypto";

import { Neev } from "@neevcloud/sdk";

process.env.RUNTIME_BASE_URL ||= "https://neev-smoke-test.invalid";

const { AgentClient } = await import("@/lib/runtime/agent-client");
const { ComputerRuntimeProvider } = await import("@/lib/runtime/computer-provider");
const { deploymentName, sweepable } = await import("@/lib/runtime/orphan-boxes");
const { NeevBackend } = await import("@/lib/runtime/sandbox/neev");
type BoxResources = import("@/lib/runtime/sandbox/backend").BoxResources;

/** Neev's own backend, its boxes named as a smoke test's. */
class SmokeBackend extends NeevBackend {
  override create(labels: Record<string, string>, size?: BoxResources) {
    return super.create({ ...labels, "runtime.engine": "smoketest" }, size);
  }
}

const backend = new SmokeBackend();
const provider = new ComputerRuntimeProvider("neev", backend);
const neev = new Neev({
  apiKey: process.env.NEEV_API_KEY,
  orgId: process.env.NEEV_ORG_ID,
  projectId: process.env.NEEV_PROJECT_ID,
  baseURL: process.env.NEEV_BASE_URL || undefined,
});
const secret = randomBytes(32).toString("hex");
const SIZE = { cpu: 1, memoryGb: 2 };
const MARK = `smoke-${Date.now().toString(36)}`;
const identity = { workspaceId: "smoke", projectId: "smoke", computerId: "smoke", userId: "smoke" };

let sandboxId: string | null = null;
const results: { step: string; ok: boolean; seconds: number; note?: string }[] = [];

async function step(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  const start = performance.now();
  try {
    const note = (await fn()) ?? undefined;
    results.push({ step: name, ok: true, seconds: secs(start), note });
  } catch (error) {
    results.push({ step: name, ok: false, seconds: secs(start), note: error instanceof Error ? error.message : String(error) });
  }
  const r = results.at(-1)!;
  console.log(`${r.ok ? "✓" : "✗"} ${name} (${r.seconds}s)${r.note ? `: ${r.note}` : ""}`);
  return r.ok;
}

function secs(start: number): number {
  return Math.round((performance.now() - start) / 100) / 10;
}

async function sh(command: string): Promise<string> {
  const res = await (await backend.get(sandboxId!)).io.exec(command);
  if (res.exitCode !== 0) throw new Error(`exit ${res.exitCode}: ${res.stdout.trim().slice(-300)}`);
  return res.stdout.trim();
}

async function health(): Promise<string> {
  const target = await provider.agentTarget(sandboxId!, secret, { fresh: true });
  const h = await new AgentClient(target).health(identity);
  return `agent ${JSON.stringify(h).slice(0, 160)}`;
}

async function main() {
  const provisioned = await step("provision (create, prepare, agent boot)", async () => {
    const result = await provider.provisionComputer({
      secret,
      size: SIZE,
      onBox: async (id) => {
        sandboxId = id;
      },
      onStage: (stage, ms) => console.log(`    ${stage}: ${Math.round(ms / 100) / 10}s`),
    });
    const box = await neev.sandboxes.get(result.sandboxId);
    return `${box.name} (${box.id}), cpu ${result.cpu}, resources ${JSON.stringify(box.resources)}`;
  });
  if (!provisioned || !sandboxId) return;

  await step("agent health through the tunnel", health);
  await step("command as the box user, writing a file", async () => {
    const out = await sh(`echo ${MARK} > ~/${MARK}.txt && whoami && nproc && free -m | awk '/Mem/{print $2" MB"}' && df -h ~ | tail -1`);
    return out.replace(/\n/g, " | ");
  });
  await step("orphan sweep lists it as this deployment's", async () => {
    const deployment = deploymentName(process.env.RUNTIME_BASE_URL);
    for await (const box of backend.list()) {
      if (box.id !== sandboxId) continue;
      const tooNew = !sweepable(box, Date.now(), deployment);
      const sweepableLater = sweepable(box, Date.now() + 3 * 60 * 60_000, deployment);
      if (!tooNew || !sweepableLater) throw new Error(`sweepable now ${!tooNew}, in 3 h ${sweepableLater}`);
      return `labels ${JSON.stringify(box.labels)}, state ${box.state}`;
    }
    throw new Error("not listed");
  });
  await step("pause", async () => {
    await provider.pauseComputer(sandboxId!);
    const alive = await provider.computerRunning(sandboxId!);
    const phase = (await neev.sandboxes.get(sandboxId!)).phase;
    if (alive) throw new Error(`still alive, phase ${phase}`);
    return `phase ${phase}`;
  });
  await step("resume on the same box, agent booted again", async () => {
    const result = await provider.provisionComputer({ secret, size: SIZE, previousSandboxId: sandboxId! });
    if (result.sandboxId !== sandboxId) throw new Error(`a new box ${result.sandboxId}, not ${sandboxId}`);
    return `phase ${(await neev.sandboxes.get(sandboxId!)).phase}`;
  });
  await step("agent health after resume", health);
  await step("file survived the pause", async () => {
    const out = await sh(`cat ~/${MARK}.txt`);
    if (out !== MARK) throw new Error(`read "${out}"`);
    return "yes";
  });
}

try {
  await main();
} finally {
  if (sandboxId) {
    await step("delete", async () => {
      await provider.destroyComputerOrThrow(sandboxId!);
      if (await provider.computerRunning(sandboxId!)) throw new Error("still running");
    });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  process.exitCode = failed.length ? 1 : 0;
}
