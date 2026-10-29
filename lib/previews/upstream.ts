/**
 * The ways this server reaches a preview's port (PreviewTarget), kept a few
 * minutes each: the provider is asked once in a while, not on every
 * visitor's every few seconds. A Daytona link is signed for the port and
 * lasts a quarter of an hour; it's used for five minutes, and expired a
 * minute after the next one replaces it, or at once when its preview is
 * deleted or made sign-in only (revokePreviewUpstream), by this process. A box that moves (a
 * new sandbox on waking) has a new id, so a new entry.
 */

import { forgetPreviewDecisions } from "@/lib/previews/forget";
import type { PreviewUpstream } from "@/lib/previews/wire";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { resolveProvider } from "@/lib/runtime/resolve";
import type { PreviewTarget } from "@/lib/runtime/sandbox/backend";
import type { Workspace } from "@/lib/runtime/types";

const UPSTREAM_TTL_MS = 5 * 60_000;
/** How long a replaced link keeps working, for requests the proxy decided
 *  on with it (lib/previews/proxy.ts keeps a decision ten seconds). */
const REPLACED_GRACE_MS = 60_000;

/** The most ways kept at once: one a preview in use. */
const MAX_KEPT = 1000;

type Kept = { at: number; target: Promise<PreviewTarget | null> };

const store = globalThis as { __outrunnerPreviewUpstreams?: Map<string, Kept> };
const upstreams = (store.__outrunnerPreviewUpstreams ??= new Map());

/** Keyed by session first, so a preview's links are found without its box. */
const keyOf = (workspaceId: string, provider: string, sandboxId: string, port: number) => `${workspaceId}:${provider}:${sandboxId}:${port}`;

function revokeLater(kept: Kept, delayMs: number): void {
  const revoke = () =>
    void kept.target
      .then((target) => target?.revoke?.())
      .catch((error: unknown) => console.error("Preview: couldn't expire a way to a box's port", error));
  if (delayMs <= 0) return revoke();
  setTimeout(revoke, delayMs).unref?.();
}

/**
 * Room for one more: ways past their five minutes, which nothing is given
 * any more, and then the oldest are expired after the grace a replaced
 * link gets, so a proxy decision already in flight can finish.
 */
function evict(): void {
  for (const [key, kept] of upstreams) {
    if (Date.now() - kept.at < UPSTREAM_TTL_MS) continue;
    upstreams.delete(key);
    revokeLater(kept, REPLACED_GRACE_MS);
  }
  for (const [key, kept] of upstreams) {
    if (upstreams.size < MAX_KEPT) break;
    upstreams.delete(key);
    revokeLater(kept, REPLACED_GRACE_MS);
  }
}

/** The way to `port` on the session's box; null where the provider has none. */
export async function previewUpstream(workspace: Workspace, sandboxId: string, port: number): Promise<PreviewUpstream | null> {
  const key = keyOf(workspace.id, workspace.provider, sandboxId, port);
  let kept = upstreams.get(key);
  if (!kept || Date.now() - kept.at >= UPSTREAM_TTL_MS) {
    const resolution = resolveProvider(workspace);
    if (!resolution.ok || !isComputerProvider(resolution.provider)) return null;
    if (kept) revokeLater(kept, REPLACED_GRACE_MS);
    const target = resolution.provider.previewTarget(sandboxId, port);
    if (upstreams.size >= MAX_KEPT) evict();
    const fresh: Kept = { at: Date.now(), target };
    upstreams.set(key, fresh);
    // A failed lookup isn't kept: the next visitor asks again.
    target.catch(() => {
      if (upstreams.get(key) === fresh) upstreams.delete(key);
    });
    kept = fresh;
  }
  const target = await kept.target;
  // What the proxy is sent: no credential's handle, only the way in.
  return target && { baseUrl: target.baseUrl, headers: target.headers, hostHeader: target.hostHeader };
}

/**
 * End every way kept to a preview's port, now: it was deleted or made
 * sign-in only, so a link that leaked must stop working with the preview,
 * not when it would have expired. The proxy forgets its answers for the
 * preview first (lib/previews/forget.ts), so a visitor still let in asks
 * the gate again and gets a fresh way, never the expired one. Best effort,
 * and only in this process: a link kept by one gone (a restart, a deploy)
 * ends when its quarter hour does.
 */
export function revokePreviewUpstream(preview: { workspaceId: string; port: number; slug: string }): void {
  const revoked: Kept[] = [];
  for (const [key, kept] of upstreams) {
    if (key.startsWith(`${preview.workspaceId}:`) && key.endsWith(`:${preview.port}`)) {
      upstreams.delete(key);
      revoked.push(kept);
    }
  }
  forgetPreviewDecisions(preview.slug);
  for (const kept of revoked) revokeLater(kept, 0);
}
