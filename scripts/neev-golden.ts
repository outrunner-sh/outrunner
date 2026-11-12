/**
 * Build Neev's golden boxes: for each box size, a box with everything the
 * setup script installs (tmux, git-lfs, ripgrep, jq, Claude Code, Codex, gh)
 * and the box user, snapshotted and then paused. A new box of that size is
 * restored from the snapshot instead of made from the template and set up
 * (lib/runtime/sandbox/neev.ts fromGolden): measured, about 36 s instead of
 * about 2 minutes.
 *
 * Why a snapshot of a paused box rather than a fork of a running one, all
 * measured on Neev (2026-11-12):
 *  - Neev refuses to fork a paused box, so a fork needs the golden box
 *    running, and billed, around the clock. A snapshot restores with its
 *    box paused: only its disk is kept.
 *  - A fork takes its source's size; a restore must be the snapshot's size
 *    exactly. So one golden box per size either way, and resizing a fork in
 *    place left the guest's memory where it was.
 *  - A fork took 57 s to be ready, a restore 36 s.
 *  - A snapshot goes with its box: deleting a golden box takes its snapshot.
 *    So golden boxes are kept, paused, with no retention limit.
 *
 * Each golden box is named for its size and the version of what it holds
 * (goldenVersion: the setup script with its pinned tools, the template, the
 * disk, the home's place): `outrunner-golden-2c4g-1a2b3c4d`. Change any of
 * them and boxes stop using the old ones (they're made the slow way) until
 * this is run again. The agent isn't in it: every box gets the agent as it
 * is provisioned, so a new agent needs no rebuild.
 *
 * A golden box is never given an agent, a secret or a credential: nothing
 * but the setup script runs on it, and this checks before snapshotting that
 * no CLI left a login behind. Each restore gets its own hostname (its name);
 * there's no machine-id or SSH host key on the template to share.
 *
 *   node --experimental-strip-types --import ./scripts/test-loader.mjs scripts/neev-golden.ts [--sizes small,medium] [--force] [--prune]
 *
 * --force rebuilds this version's golden boxes; --prune deletes golden boxes
 * of other versions (only once nothing deployed runs them: another
 * deployment on the same project may). Needs NEEV_API_KEY (a project key),
 * NEEV_ORG_ID, NEEV_PROJECT_ID; NEEV_SANDBOX_TEMPLATE / NEEV_BASE_URL as the
 * app has them.
 */

import { Neev, type Sandbox } from "@neevcloud/sdk";

const { BOX_SIZES } = await import("@/lib/runtime/box-sizes");
const neevLib = await import("@/lib/runtime/sandbox/neev");
const { prepare, hasTools, SandboxRuntime, BOX_HOME, NEEV_LIFECYCLE, NEEV_DISK_GB, GOLDEN_PREFIX, goldenName, goldenSizeKey, goldenVersion, findGoldenSnapshot, neevTemplate } =
  neevLib;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const sizesArg = args.find((a, i) => args[i - 1] === "--sizes");
const sizes = BOX_SIZES.filter((s) => !sizesArg || sizesArg.split(",").includes(s.id));
const neev = new Neev({
  apiKey: process.env.NEEV_API_KEY,
  orgId: process.env.NEEV_ORG_ID,
  projectId: process.env.NEEV_PROJECT_ID,
  baseURL: process.env.NEEV_BASE_URL || undefined,
});
const version = goldenVersion();
const secs = (start: number) => `${Math.round((Date.now() - start) / 100) / 10}s`;

/** Logins a CLI keeps, which must never be in a golden box: root's, and
 *  the box user's in its home as the app has it (BOX_HOME). */
const CREDENTIAL_FILES = [".claude.json", ".claude/.credentials.json", ".codex/auth.json", ".config/gh/hosts.yml", ".git-credentials"];
const CREDENTIAL_PATHS = ["/root", BOX_HOME].flatMap((home) => CREDENTIAL_FILES.map((file) => `${home}/${file}`));

async function waitPhase(id: string, phase: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if ((await neev.sandboxes.get(id)).phase === phase) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${id} never reached ${phase}`);
}

async function build(size: (typeof sizes)[number]): Promise<string> {
  const name = goldenName(size, version);
  const existing = (await neev.sandboxes.list({ name, limit: 10 })).items.find((box) => box.name === name);
  if (existing && !flag("force")) {
    const snapshot = await findGoldenSnapshot(neev, name);
    if (snapshot) {
      if (existing.phase === "Ready") await neev.sandboxes.pause(existing.id);
      return `${name}: up to date (snapshot ${snapshot})`;
    }
  }
  if (existing) await neev.sandboxes.delete(existing.id);

  const start = Date.now();
  const box: Sandbox = await neev.sandboxes.create({
    name,
    sandbox_template_id: neevTemplate(),
    allowInternet: true,
    resources: { cpu: size.cpu, memory_gb: size.memoryGb, disk_gb: NEEV_DISK_GB },
    // Kept paused for good: its snapshot goes with it.
    lifecycle: { ...NEEV_LIFECYCLE, paused_retention_seconds: 0 },
  } as Parameters<typeof neev.sandboxes.create>[0]);
  try {
    await box.waitUntilReady({ timeoutMs: 300_000 });
    const runtime = new SandboxRuntime({ connectUrl: box.connectUrl!.replace(/\/$/, ""), apiKey: process.env.NEEV_API_KEY! });
    await prepare(runtime);
    if (!(await hasTools(runtime))) throw new Error("the setup script ran, but its tools aren't all there");
    const found = await runtime.exec("bash", ["-c", `ls -d ${CREDENTIAL_PATHS.join(" ")} 2>/dev/null; true`]);
    if (found.stdout.trim()) throw new Error(`credentials on the golden box: ${found.stdout.trim()}`);
    const snapshot = await neev.sandboxes.createSnapshot(box.id, { name: `${name}-snap` });
    const ready = await neev.sandboxes.waitForSnapshot(snapshot.id, { timeoutMs: 900_000 });
    await neev.sandboxes.pause(box.id);
    await waitPhase(box.id, "Paused");
    return `${name}: built in ${secs(start)} (box ${box.id}, snapshot ${ready.id}, ${Math.round((ready.size_bytes ?? 0) / 1e6)} MB)`;
  } catch (error) {
    await neev.sandboxes.delete(box.id).catch(() => {});
    throw new Error(`${name}: ${(error as Error).message}`);
  }
}

console.log(`Golden version ${version}, template ${neevTemplate()}, ${NEEV_DISK_GB} GB; sizes ${sizes.map((s) => `${s.id} (${goldenSizeKey(s)})`).join(", ")}`);
const results = await Promise.allSettled(sizes.map(build));
for (const result of results) console.log(result.status === "fulfilled" ? `✓ ${result.value}` : `✗ ${(result.reason as Error).message}`);

if (flag("prune")) {
  // Listed in full first: deleting while paging would skip boxes.
  const current = new Set(BOX_SIZES.map((s) => goldenName(s, version)));
  const stale: Sandbox[] = [];
  for (let page = 1; ; page++) {
    const listed = await neev.sandboxes.list({ page, limit: 100 });
    stale.push(...listed.items.filter((box) => box.name.startsWith(GOLDEN_PREFIX) && !current.has(box.name)));
    if (listed.items.length < 100) break;
  }
  for (const box of stale) {
    await neev.sandboxes.delete(box.id);
    console.log(`Pruned ${box.name} (${box.id}), another version's`);
  }
}
process.exitCode = results.some((r) => r.status === "rejected") ? 1 : 0;
