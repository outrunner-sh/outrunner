import { providerName } from "@/lib/env";
import { DaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import { LocalRuntimeProvider } from "@/lib/runtime/local-provider";
import { NeevRuntimeProvider } from "@/lib/runtime/neev-provider";
import type { RuntimeProvider } from "@/lib/runtime/types";

let cached: RuntimeProvider | null = null;

/**
 * Resolve the active RuntimeProvider.
 *
 * `local` runs everything in a directory on this machine and exists so the
 * whole product (API surface, UI, lifecycle) can be developed and tested
 * without a cloud backend. `neev` and `daytona` are the real backends (one
 * always-on Runtime Computer per project, on Neev or Daytona sandboxes), so
 * every cloud box is metered and the plan's limits hold. The legacy `modal`
 * workspace-per-sandbox backend was removed: nothing metered its boxes.
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
    default:
      cached = new LocalRuntimeProvider();
  }
  return cached;
}

/** Test seam: drop the memoized provider. */
export function resetRuntimeProvider(): void {
  cached = null;
}
