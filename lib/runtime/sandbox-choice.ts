import type { SandboxSettings } from "@/lib/db/credentials";
import { boxSize, DEFAULT_BOX_SIZE } from "@/lib/runtime/box-sizes";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { NoDaytonaKeyError, UserDaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import { getRuntimeProvider } from "@/lib/runtime/provider";
import type { BoxResources } from "@/lib/runtime/sandbox/backend";
import type { ModalToken } from "@/lib/runtime/sandbox/modal";
import type { ProviderName, RuntimeComputer, RuntimeProvider } from "@/lib/runtime/types";
import { NoModalTokenError, UserModalRuntimeProvider } from "@/lib/runtime/user-modal-provider";

/**
 * Which provider a cloud session runs on, per user (Settings → Sandbox):
 * Outrunner's own sandboxes, the deployment's provider and the default, or
 * the user's own Daytona or Modal account on their key. The caller reads the
 * keys (`keys`, the owner's stored ones), so this stays free of the database.
 */
export type OwnSandboxKeys = {
  daytona: () => Promise<string | null>;
  modal: () => Promise<ModalToken | null>;
};

/**
 * The provider that made a workspace or computer, to manage it with: the
 * deployment's own, or its owner's Daytona or Modal. Null for one this
 * deployment no longer runs (its provider was switched).
 */
export function providerNamed(name: ProviderName, keys: OwnSandboxKeys): RuntimeProvider | null {
  if (name === "user-daytona") return new UserDaytonaRuntimeProvider(keys.daytona);
  if (name === "user-modal") return new UserModalRuntimeProvider(keys.modal);
  const deployment = getRuntimeProvider();
  return deployment.name === name ? deployment : null;
}

/** Where a user's new cloud sessions go, by their settings. Throws
 *  {@link NoDaytonaKeyError} or {@link NoModalTokenError} when they chose
 *  their own and its key is gone. */
export function providerForNewSessions(settings: SandboxSettings, keys: OwnSandboxKeys): RuntimeProvider {
  switch (settings.sandbox) {
    case "daytona":
      if (!settings.daytona.connected) throw new NoDaytonaKeyError();
      return new UserDaytonaRuntimeProvider(keys.daytona);
    case "modal":
      if (!settings.modal.connected) throw new NoModalTokenError();
      return new UserModalRuntimeProvider(keys.modal);
    default:
      return getRuntimeProvider();
  }
}

/**
 * How big a new box is, by the user's settings: their size, on their own Modal
 * or on Outrunner's sandboxes (where a backend that can't size one ignores
 * it). On Outrunner's, a size for a higher plan, one chosen for Modal, is the
 * default instead. Their own Daytona keeps its own.
 */
export function newBoxSize(settings: SandboxSettings): BoxResources | undefined {
  const size = boxSize(settings.boxSize);
  if (settings.sandbox === "modal") return size;
  if (settings.sandbox === "outrunner") return size.locked ? boxSize(DEFAULT_BOX_SIZE) : size;
  return undefined;
}

/** The provider that has a project's computer: the one recorded, or the
 *  deployment's for one from before that was recorded. */
export function computerMadeBy(computer: Pick<RuntimeComputer, "provider">): ProviderName {
  return computer.provider ?? getRuntimeProvider().name;
}

/** The box of a computer already found ended (marked stopped, its box id
 *  kept), when `provider` made it: what a provider that brings boxes back on
 *  the disk they left starts the next one from. */
export function endedBoxOf(
  computer: Pick<RuntimeComputer, "status" | "daytonaSandboxId" | "provider"> | null,
  provider: ProviderName,
): string | undefined {
  return computer?.status === "stopped" && computer.daytonaSandboxId && computerMadeBy(computer) === provider
    ? computer.daytonaSandboxId
    : undefined;
}

/** Delete a box with the provider that made it, as its project moves to
 *  another. Best effort: a box that can't be reached is logged and left. */
export async function retireComputer(
  madeBy: ProviderName,
  keys: OwnSandboxKeys,
  sandboxId: string,
): Promise<void> {
  const old = providerNamed(madeBy, keys);
  if (old && isComputerProvider(old)) await old.destroyComputer(sandboxId);
}
