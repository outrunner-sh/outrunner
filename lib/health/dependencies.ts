import { optionalEnv } from "@/lib/env";
import { withTimeout } from "@/lib/http/timeout";
import { managementKey, readCurrentKey, sharedApiKey } from "@/lib/openrouter/keys";
import { daytonaAcceptsKey } from "@/lib/runtime/sandbox/daytona";

/** What a dependency check found: it answered and took the key, it refused
 *  the key, it couldn't be asked (down, slow), or there's nothing to ask. */
export type DependencyCheck = "ok" | "refused" | "unreachable" | "not configured";

/** How long /api/health waits on each dependency. */
const CHECK_TIMEOUT_MS = 5_000;

/** Whether Daytona takes this deployment's key: one page of its sandboxes. */
export async function checkDaytona(): Promise<DependencyCheck> {
  const key = optionalEnv("DAYTONA_API_KEY");
  if (!key) return "not configured";
  try {
    return (await withTimeout(daytonaAcceptsKey(key), CHECK_TIMEOUT_MS, "Daytona's key check")) ? "ok" : "refused";
  } catch {
    return "unreachable";
  }
}

/** Whether OpenRouter takes Outrunner's own key (the management key, else the
 *  shared one): its /key, which spends nothing. */
export async function checkOpenRouter(): Promise<DependencyCheck> {
  const key = managementKey() ?? sharedApiKey();
  if (!key) return "not configured";
  try {
    return (await withTimeout(readCurrentKey(key), CHECK_TIMEOUT_MS, "OpenRouter's key check")) ? "ok" : "refused";
  } catch {
    return "unreachable";
  }
}
