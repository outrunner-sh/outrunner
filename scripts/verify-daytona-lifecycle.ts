/**
 * Can Daytona carry one VM per workspace? Checks on a real box what that plan
 * leans on, and times each step:
 *
 *   1. stop → start keeps the disk (sleep and wake);
 *   2. pause → start keeps running processes, where the box's class can pause;
 *   3. a snapshot made from a box starts new boxes with its files (warm pool);
 *   4. fork clones a box's disk into a new one;
 *   5. auto-stop can be set on a box (Daytona sleeps idle ones itself).
 *
 * Everything it makes is labelled and deleted at the end, even on failure.
 *
 *   node --experimental-strip-types --env-file=.env.local scripts/verify-daytona-lifecycle.ts
 *
 * Needs DAYTONA_API_KEY (optional DAYTONA_API_URL / DAYTONA_TARGET).
 */

import { Daytona, type Sandbox } from "@daytonaio/sdk";

const RUN = `lifecycle-${Date.now().toString(36)}`;
const LABELS = { "outrunner-verify": RUN };
const MARK = `/home/daytona/${RUN}.txt`;

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
  apiUrl: process.env.DAYTONA_API_URL || undefined,
  target: process.env.DAYTONA_TARGET || undefined,
});

const made: Sandbox[] = [];
let snapshotName: string | null = null;
const results: { step: string; ok: boolean | "n/a"; seconds?: number; note?: string }[] = [];

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await fn();
  return [value, Math.round((performance.now() - start) / 100) / 10];
}

async function sh(box: Sandbox, command: string): Promise<string> {
  const res = await box.process.executeCommand(command, undefined, undefined, 60);
  return (res.result ?? "").trim();
}

async function step(name: string, fn: () => Promise<{ ok: boolean | "n/a"; seconds?: number; note?: string }>) {
  try {
    const r = await fn();
    results.push({ step: name, ...r });
  } catch (error) {
    results.push({ step: name, ok: false, note: error instanceof Error ? error.message : String(error) });
  }
  const r = results.at(-1)!;
  console.log(`${r.ok === true ? "✓" : r.ok === "n/a" ? "–" : "✗"} ${name}${r.seconds !== undefined ? ` (${r.seconds}s)` : ""}${r.note ? `: ${r.note}` : ""}`);
}

async function main() {
  const [box, createSeconds] = await timed(() =>
    daytona.create({ labels: LABELS, autoStopInterval: 0, autoDeleteInterval: -1 }, { timeout: 180 }),
  );
  made.push(box);
  console.log(`box ${box.id} created in ${createSeconds}s`);
  await sh(box, `echo ${RUN} > ${MARK} && (nohup sleep 100000 >/dev/null 2>&1 &) && echo ok`);

  await step("stop → start keeps the disk", async () => {
    const [, stopS] = await timed(() => box.stop());
    const [, startS] = await timed(() => box.start(120));
    const kept = (await sh(box, `cat ${MARK} 2>/dev/null`)) === RUN;
    return { ok: kept, seconds: startS, note: `stop ${stopS}s, start ${startS}s${kept ? "" : ", file gone"}` };
  });

  await sh(box, `(nohup sleep 100001 >/dev/null 2>&1 &) && echo ok`);
  await step("pause → start keeps running processes", async () => {
    try {
      const [, pauseS] = await timed(() => box.pause());
      const [, startS] = await timed(() => box.start(120));
      const alive = (await sh(box, `pgrep -f 'sleep 100001' >/dev/null && echo yes || echo no`)) === "yes";
      return { ok: alive, seconds: startS, note: `pause ${pauseS}s, resume ${startS}s${alive ? "" : ", process gone"}` };
    } catch (error) {
      await box.refreshData().catch(() => {});
      if (box.state !== "started") await box.start(120).catch(() => {});
      return { ok: "n/a", note: `not on this box class: ${error instanceof Error ? error.message : error}` };
    }
  });

  await step("auto-stop can be set (Daytona sleeps idle boxes)", async () => {
    await box.setAutostopInterval(30);
    await box.refreshData();
    const readBack = box.autoStopInterval;
    await box.setAutostopInterval(0);
    return { ok: readBack === 30, note: `set to 30 min, read back as ${readBack ?? "unknown"}` };
  });

  await step("snapshot of a box starts new boxes with its files", async () => {
    snapshotName = `outrunner-verify-${RUN}`;
    const [, snapS] = await timed(() => box.createSnapshot(snapshotName!, 600));
    const [fromSnap, startS] = await timed(() =>
      daytona.create({ snapshot: snapshotName!, labels: LABELS, autoStopInterval: 0, autoDeleteInterval: -1 }, { timeout: 300 }),
    );
    made.push(fromSnap);
    const kept = (await sh(fromSnap, `cat ${MARK} 2>/dev/null`)) === RUN;
    return { ok: kept, seconds: startS, note: `snapshot ${snapS}s, new box from it ${startS}s${kept ? "" : ", file missing"}` };
  });

  await step("fork clones a box's disk", async () => {
    const [forked, forkS] = await timed(() => box.fork({}, 180));
    made.push(forked);
    await forked.setLabels(LABELS).catch(() => {});
    const kept = (await sh(forked, `cat ${MARK} 2>/dev/null`)) === RUN;
    return { ok: kept, seconds: forkS, note: kept ? undefined : "file missing" };
  });
}

async function cleanUp() {
  for (const box of made) {
    await box.delete(60).catch((e: unknown) => console.error(`! could not delete box ${box.id}:`, e));
  }
  // Anything labelled for this run that the steps didn't hold on to.
  for await (const box of daytona.list({ labels: LABELS })) {
    if (!made.some((m) => m.id === box.id)) await box.delete(60).catch(() => {});
  }
  let snapshotLeft = false;
  if (snapshotName) {
    try {
      await daytona.snapshot.delete(await daytona.snapshot.get(snapshotName));
    } catch (e) {
      snapshotLeft = true;
      const status = (e as { statusCode?: number }).statusCode;
      console.error(`! could not delete snapshot ${snapshotName} (${status ?? (e as Error).message}): delete it in Daytona's dashboard`);
    }
  }
  console.log(`deleted ${made.length} box(es)${snapshotName && !snapshotLeft ? " and the snapshot" : ""}`);
}

try {
  await main();
} catch (error) {
  console.error("✗ setup failed:", error);
  process.exitCode = 1;
} finally {
  await cleanUp();
  console.log("\n" + JSON.stringify(results, null, 2));
}
