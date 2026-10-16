import type { SandboxSettings } from "@/lib/db/credentials";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { NoDaytonaKeyError, UserDaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import { getRuntimeProvider } from "@/lib/runtime/provider";
import type { ProviderName, RuntimeComputer, RuntimeProvider } from "@/lib/runtime/types";

/**
 * Which provider a cloud session runs on, per user (Settings → Sandbox):
 * Outrunner's own sandboxes, the deployment's provider and the default, or
 * the user's own Daytona account on their key. The caller reads the key
 * (`daytonaKey`, the owner's stored one), so this stays free of the database.
 */
export type DaytonaKey = () => Promise<string | null>;

/**
 * The provider that made a workspace or computer, to manage it with: the
 * deployment's own, or its owner's Daytona for `user-daytona`. Null for one
 * this deployment no longer runs (its provider was switched).
 */
export function providerNamed(name: ProviderName, daytonaKey: DaytonaKey): RuntimeProvider | null {
  if (name === "user-daytona") return new UserDaytonaRuntimeProvider(daytonaKey);
  const deployment = getRuntimeProvider();
  return deployment.name === name ? deployment : null;
}

/** Where a user's new cloud sessions go, by their settings. Throws
 *  {@link NoDaytonaKeyError} when they chose their own Daytona and its key is
 *  gone. */
export function providerForNewSessions(settings: SandboxSettings, daytonaKey: DaytonaKey): RuntimeProvider {
  if (settings.sandbox !== "daytona") return getRuntimeProvider();
  if (!settings.daytona.connected) throw new NoDaytonaKeyError();
  return new UserDaytonaRuntimeProvider(daytonaKey);
}

/** The provider that has a project's computer: the one recorded, or the
 *  deployment's for one from before that was recorded. */
export function computerMadeBy(computer: Pick<RuntimeComputer, "provider">): ProviderName {
  return computer.provider ?? getRuntimeProvider().name;
}

/** Delete a box with the provider that made it, as its project moves to
 *  another. Best effort: a box that can't be reached is logged and left. */
export async function retireComputer(
  madeBy: ProviderName,
  daytonaKey: DaytonaKey,
  sandboxId: string,
): Promise<void> {
  const old = providerNamed(madeBy, daytonaKey);
  if (old && isComputerProvider(old)) await old.destroyComputer(sandboxId);
}
