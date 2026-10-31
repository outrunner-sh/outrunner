import { NoGcpConnectionError, UserGcpRuntimeProvider } from "@/lib/runtime/user-gcp-provider";
import type { GcpConnection } from "@/lib/runtime/gcp/config";
import { boxSizeWithin, type Plan } from "@/lib/billing/plans";
import type { SandboxChoice, SandboxSettings } from "@/lib/db/credentials";
import { boxSize, type BoxSizeId } from "@/lib/runtime/box-sizes";
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
  ownerId?: string;
  gcp?: () => Promise<GcpConnection | null>;
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
  if (name === "user-gcp") return new UserGcpRuntimeProvider(keys.ownerId ?? "", keys.gcp ?? (async () => null));
  if (name === "user-modal") return new UserModalRuntimeProvider(keys.modal);
  const deployment = getRuntimeProvider();
  return deployment.name === name ? deployment : null;
}

/** Where a user's new cloud sessions go, by their settings. Throws
 *  {@link NoDaytonaKeyError} or {@link NoModalTokenError} when they chose
 *  their own and its key is gone. */
export function providerForNewSessions(settings: SandboxSettings, keys: OwnSandboxKeys): RuntimeProvider {
  switch (settings.sandbox) {
    case "gcp":
      if (!settings.gcp?.connected || !keys.gcp || !keys.ownerId) throw new NoGcpConnectionError();
      return new UserGcpRuntimeProvider(keys.ownerId, keys.gcp);
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
 * How big a box on `sandbox` is: the user's size on their own Modal, which
 * bills them; on Outrunner's sandboxes (where a backend that can't size one
 * ignores it), at most the largest their plan allows. Their own Daytona keeps
 * its own.
 */
export function boxSizeOn(sandbox: SandboxChoice, size: BoxSizeId, plan: Plan): BoxResources | undefined {
  if (sandbox === "gcp") return boxSize(size === "x-small" ? "small" : size);
  if (sandbox === "modal") return boxSize(size);
  if (sandbox === "outrunner") return boxSizeWithin(plan, size);
  return undefined;
}

/** Which sandbox a provider is: the user's own Daytona or Modal, or
 *  Outrunner's (the deployment's). */
export function sandboxOf(name: ProviderName): SandboxChoice {
  if (name === "user-daytona") return "daytona";
  if (name === "user-modal") return "modal";
  if (name === "user-gcp") return "gcp";
  return "outrunner";
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
