import type { RuntimeComputer, Workspace } from "@/lib/runtime/types";

export type ResourceReading = { allocated: number | null; used: number | null };
export type ComputerReading = {
  cpu: ResourceReading;
  memory: ResourceReading;
  disk: ResourceReading;
  sampledAt: string | null;
};
export type SessionInfo = ComputerReading & {
  state: "running" | "paused" | "unavailable";
  provider: Workspace["provider"];
  environment: string | null;
  runtimeVersion: string | null;
};
export const NO_READING: ComputerReading = {
  cpu: { allocated: null, used: null },
  memory: { allocated: null, used: null },
  disk: { allocated: null, used: null },
  sampledAt: null,
};

/** Fixed read-only probes: cgroup limits/consumption, and root filesystem capacity.
 * CPU consumption is cumulative seconds, never presented as a live percentage.
 * No environment, command output or credentials leave this parser. */
export const RESOURCE_PROBE = `timeout 3 sh -c '
for name in memory.max memory.current cpu.stat; do
  printf "%s\n" "$name"
  cat "/sys/fs/cgroup/$name" 2>/dev/null || true
done
printf "disk\n"
df -B1 --output=size,used / 2>/dev/null | tail -1
'`;

export function resourceReading(
  output: string,
  cpu?: number,
  memoryGb?: number,
): ComputerReading {
  const positive = (value: unknown): number | null => {
    const n =
      typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : value;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
  };
  const line = (name: string) =>
    output.match(new RegExp(`(?:^|\\n)${name}\\n([^\\n]+)`))?.[1];
  const cpuMicros = positive(output.match(/(?:^|\n)usage_usec (\d+)/)?.[1]);
  const disk = line("disk")?.trim().split(/\s+/) ?? [];
  return {
    cpu: {
      allocated: positive(cpu),
      used: cpuMicros === null ? null : cpuMicros / 1e6,
    },
    memory: {
      allocated:
        positive(line("memory.max")) ??
        (memoryGb === undefined ? null : positive(memoryGb * 1024 ** 3)),
      used: positive(line("memory.current")),
    },
    disk: { allocated: positive(disk[0]), used: positive(disk[1]) },
    sampledAt: new Date().toISOString(),
  };
}

export type InfoDependencies = {
  computer: (workspace: Workspace) => Promise<RuntimeComputer | null>;
  environment: (id: string) => Promise<string | null>;
  inspect: (
    workspace: Workspace,
    sandboxId: string,
  ) => Promise<ComputerReading | null>;
};
/** Called only after the caller has read the session under its normal RLS.
 * A stopped/archived box is never contacted, resumed or attached. */
export async function readSessionInfo(
  workspace: Workspace,
  deps: InfoDependencies,
): Promise<SessionInfo> {
  const [computer, environment] = await Promise.all([
    deps.computer(workspace),
    workspace.environmentId
      ? deps.environment(workspace.environmentId)
      : Promise.resolve(null),
  ]);
  const base: SessionInfo = {
    ...NO_READING,
    state: "unavailable",
    provider: workspace.provider,
    environment,
    runtimeVersion: computer?.imageVersion ?? null,
  };
  if (
    computer?.status === "stopped" ||
    ["suspended", "archived"].includes(workspace.status)
  )
    return { ...base, state: "paused" };
  if (
    !computer?.daytonaSandboxId ||
    computer.status !== "ready" ||
    !["ready", "idle"].includes(workspace.status)
  )
    return base;
  const reading = await deps
    .inspect(workspace, computer.daytonaSandboxId)
    .catch(() => null);
  return reading ? { ...base, ...reading, state: "running" } : base;
}

/** Keep permission checks ahead of every resource/environment read. The visible
 * session reader is the same RLS-bound reader the session page uses. */
export async function visibleSessionInfo(
  id: string,
  deps: InfoDependencies & {
    signedIn: () => Promise<boolean>;
    visibleWorkspace: (id: string) => Promise<Workspace | null>;
  },
): Promise<{ status: 200; info: SessionInfo } | { status: 401 | 404 }> {
  if (!(await deps.signedIn())) return { status: 401 };
  const workspace = await deps.visibleWorkspace(id);
  if (!workspace) return { status: 404 };
  return { status: 200, info: await readSessionInfo(workspace, deps) };
}
