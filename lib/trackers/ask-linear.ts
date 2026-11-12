/** Asking Linear something with an install's token, on the server. */

import { withToken } from "@/lib/trackers/tokens";
import { tokenDeps } from "@/lib/trackers/tokens.deps";

/**
 * A disconnected install answers `fallback`. Linear being down, or a refresh
 * taking too long, throws, for the caller to try again. See {@link withToken}.
 */
export function askLinear<T, F>(installationId: string, fallback: F, question: (token: string) => Promise<T>): Promise<T | F> {
  return withToken(installationId, fallback, question, tokenDeps);
}
