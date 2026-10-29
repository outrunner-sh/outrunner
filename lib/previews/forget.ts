/**
 * How the app tells the preview proxy to forget what it decided about a
 * preview: the proxy (lib/previews/proxy.ts, in the custom server) and the
 * app's routes run in one process but load their own copies of modules, so
 * the proxy leaves its hook on globalThis. Imports nothing, so Node runs it
 * as is for the server.
 */

const store = globalThis as { __outrunnerForgetPreview?: (slug: string) => void };

/** The proxy's hook: called with a slug, it drops every answer it keeps
 *  for that preview, and its visitors' next requests ask the gate again. */
export function onForgetPreview(forget: (slug: string) => void): void {
  store.__outrunnerForgetPreview = forget;
}

/** Have the proxy ask the gate again for `slug`'s visitors: its link to the
 *  box was expired, or the preview deleted. Nothing outside the server. */
export function forgetPreviewDecisions(slug: string): void {
  store.__outrunnerForgetPreview?.(slug);
}
