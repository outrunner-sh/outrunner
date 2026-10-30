import { BOX_SIZES } from "@/lib/runtime/box-sizes";
import type { SandboxBox } from "@/lib/runtime/sandbox/backend";

const GIB = 1024 ** 3;
export const MEMORY_PRESSURE_THRESHOLD = 0.8;

/** File cache is reclaimable and shouldn't grow an otherwise quiet sandbox. */
export const MEMORY_PROBE = `timeout 3 sh -c '
for name in memory.max memory.current memory.stat; do
  printf "%s\\n" "$name"
  cat "/sys/fs/cgroup/$name" 2>/dev/null || true
done
'`;

export function memoryPressure(output: string): { limit: number; workingSet: number } | null {
  const value = (name: string) => {
    const match = output.match(new RegExp(`(?:^|\\n)${name}\\n(\\d+)(?:\\n|$)`));
    return match ? Number(match[1]) : NaN;
  };
  const limit = value("memory.max");
  const used = value("memory.current");
  const inactive = Number(output.match(/(?:^|\n)inactive_file (\d+)(?:\n|$)/)?.[1] ?? NaN);
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(used) || used < 0 ||
      !Number.isSafeInteger(inactive) || inactive > used) return null;
  return { limit, workingSet: used - inactive };
}

export type MemoryScaleResult = {
  outcome: "scaled" | "at-limit" | "no-pressure" | "unavailable";
  memoryGb?: number;
};

/** Called under the control plane's per-box lease. Measure again here rather
 * than trust a pressure report that may predate an earlier resize. Never wake
 * or stop a sandbox, or change the CPU allocation used for cloud-hour billing. */
export async function growMemoryUnderPressure(
  box: SandboxBox,
  maxMemoryGb: number,
  resizeBefore = Infinity,
): Promise<MemoryScaleResult> {
  if (!box.growMemory) return { outcome: "unavailable" };
  const reading = await box.io.exec(MEMORY_PROBE);
  const pressure = reading.exitCode === 0 ? memoryPressure(reading.stdout) : null;
  if (!pressure) return { outcome: "unavailable" };
  if (pressure.workingSet / pressure.limit < MEMORY_PRESSURE_THRESHOLD) return { outcome: "no-pressure" };
  const current = Math.max(pressure.limit / GIB, box.memoryGb ?? 0);
  const next = BOX_SIZES.find((size) => size.memoryGb > current && size.memoryGb <= maxMemoryGb);
  if (!next) return { outcome: "at-limit", memoryGb: current };
  // A slow provider read must not launch a mutation after our lease expires.
  if (Date.now() >= resizeBefore) return { outcome: "unavailable" };
  await box.growMemory(next.memoryGb);
  return { outcome: "scaled", memoryGb: next.memoryGb };
}
