import { optionalEnv, providerName } from "@/lib/env";
import { type ComputerRuntimeProvider, isComputerProvider } from "@/lib/runtime/computer-provider";
import { DaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import { E2bRuntimeProvider } from "@/lib/runtime/e2b-provider";
import { LocalRuntimeProvider } from "@/lib/runtime/local-provider";
import { ModalRuntimeProvider } from "@/lib/runtime/modal-provider";
import { NeevRuntimeProvider } from "@/lib/runtime/neev-provider";
import type { ProviderName, RuntimeProvider } from "@/lib/runtime/types";

type EnvKey = Parameters<typeof optionalEnv>[0];

let cached: RuntimeProvider | null = null;
/** Outrunner's other sandbox accounts this deployment still reaches, by name. */
const others = new Map<ProviderName, ComputerRuntimeProvider>();

/**
 * Resolve the active RuntimeProvider.
 *
 * `local` runs everything in a directory on this machine and exists so the
 * whole product (API surface, UI, lifecycle) can be developed and tested
 * without a cloud backend. `neev`, `daytona` and `e2b` are the real backends
 * (one always-on Runtime Computer per project, on Neev, Daytona or our own
 * E2B's sandboxes);
 * `modal` is the legacy workspace-per-sandbox backend.
 */
export function getRuntimeProvider(): RuntimeProvider {
  if (cached) return cached;

  switch (providerName()) {
    case "neev":
      cached = new NeevRuntimeProvider();
      break;
    case "daytona":
      cached = new DaytonaRuntimeProvider();
      break;
    case "e2b":
      cached = new E2bRuntimeProvider();
      break;
    case "modal":
      cached = new ModalRuntimeProvider();
      break;
    default:
      cached = new LocalRuntimeProvider();
  }
  return cached;
}

/**
 * The Runtime Computer backends on Outrunner's own accounts that a deployment
 * can run besides its own, each with the variables that reach it. A
 * deployment that moved from one to another (RUNTIME_PROVIDER) keeps
 * managing the boxes the old one made for as long as its credentials stay
 * set. New sessions only ever go to the deployment's own.
 */
const PLATFORM_BACKENDS: Partial<Record<ProviderName, { env: readonly EnvKey[]; make: () => ComputerRuntimeProvider }>> = {
  daytona: { env: ["DAYTONA_API_KEY"], make: () => new DaytonaRuntimeProvider() },
  neev: { env: ["NEEV_API_KEY", "NEEV_ORG_ID", "NEEV_PROJECT_ID"], make: () => new NeevRuntimeProvider() },
  e2b: { env: ["E2B_API_KEY", "E2B_API_URL", "E2B_SANDBOX_URL"], make: () => new E2bRuntimeProvider() },
};

/**
 * The provider for boxes `name` made on Outrunner's own accounts: the
 * deployment's, or another platform backend this deployment still has
 * credentials for (one it moved from). Null for any other: a user's own
 * sandbox (lib/runtime/sandbox-choice.ts reaches those on their keys), or a
 * backend this deployment can no longer reach.
 */
export function platformProvider(name: ProviderName): RuntimeProvider | null {
  const deployment = getRuntimeProvider();
  if (deployment.name === name) return deployment;
  const known = others.get(name);
  if (known) return known;
  const backend = PLATFORM_BACKENDS[name];
  if (!backend || !backend.env.every((key) => optionalEnv(key))) return null;
  const provider = backend.make();
  others.set(name, provider);
  return provider;
}

/** Every Runtime Computer provider on Outrunner's own accounts this
 *  deployment reaches, its own first. */
export function platformComputerProviders(): ComputerRuntimeProvider[] {
  const deployment = getRuntimeProvider();
  const names = [deployment.name, ...Object.keys(PLATFORM_BACKENDS)] as ProviderName[];
  const providers: ComputerRuntimeProvider[] = [];
  for (const name of new Set(names)) {
    const provider = platformProvider(name);
    if (provider && isComputerProvider(provider)) providers.push(provider);
  }
  return providers;
}

/** Test seam: drop the memoized providers. */
export function resetRuntimeProvider(): void {
  cached = null;
  others.clear();
}
