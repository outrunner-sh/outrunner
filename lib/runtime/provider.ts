import { providerName } from "@/lib/env";
import { DaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import { E2bRuntimeProvider } from "@/lib/runtime/e2b-provider";
import { LocalRuntimeProvider } from "@/lib/runtime/local-provider";
import { ModalRuntimeProvider } from "@/lib/runtime/modal-provider";
import { NeevRuntimeProvider } from "@/lib/runtime/neev-provider";
import type { RuntimeProvider } from "@/lib/runtime/types";

let cached: RuntimeProvider | null = null;

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

/** Test seam: drop the memoized provider. */
export function resetRuntimeProvider(): void {
  cached = null;
}
