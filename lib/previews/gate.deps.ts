/**
 * The gate's real dependencies (lib/previews/resolve.ts): the database as
 * the server, the session's provider, and the signing key.
 */

import { projectLevel } from "@/lib/db/org-access";
import { memberRole } from "@/lib/db/orgs";
import { boxForPreview, previewBySlug, workspaceForPreview } from "@/lib/db/previews";
import { requireEnv } from "@/lib/env";
import type { GateDeps } from "@/lib/previews/resolve";
import { previewSigningKey } from "@/lib/previews/tokens";
import type { PreviewUpstream } from "@/lib/previews/wire";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { resolveProvider } from "@/lib/runtime/resolve";
import type { Workspace } from "@/lib/runtime/types";

/** How long a way to a box's port is kept: the provider is asked once in a
 *  while, not on every visitor's every few seconds. Well inside the hour a
 *  Daytona link to it lasts. A box that moves (a new sandbox on waking) has
 *  a new id, so a new entry. */
const UPSTREAM_TTL_MS = 10 * 60_000;

const store = globalThis as { __outrunnerPreviewUpstreams?: Map<string, { at: number; target: Promise<PreviewUpstream | null> }> };
const upstreams = (store.__outrunnerPreviewUpstreams ??= new Map());

async function upstream(workspace: Workspace, sandboxId: string, port: number): Promise<PreviewUpstream | null> {
  const key = `${workspace.provider}:${sandboxId}:${port}`;
  const kept = upstreams.get(key);
  if (kept && Date.now() - kept.at < UPSTREAM_TTL_MS) return kept.target;
  const resolution = resolveProvider(workspace);
  if (!resolution.ok || !isComputerProvider(resolution.provider)) return null;
  const target = resolution.provider.previewTarget(sandboxId, port);
  if (upstreams.size > 1000) upstreams.clear();
  upstreams.set(key, { at: Date.now(), target });
  // A failed lookup isn't kept: the next visitor asks again.
  target.catch(() => {
    if (upstreams.get(key)?.target === target) upstreams.delete(key);
  });
  return target;
}

export function previewKey(): Buffer {
  return previewSigningKey(requireEnv("CREDENTIALS_ENCRYPTION_KEY"));
}

export function gateDeps(): GateDeps {
  return {
    key: previewKey(),
    appBase: new URL(requireEnv("RUNTIME_BASE_URL")).origin,
    preview: previewBySlug,
    workspace: workspaceForPreview,
    box: boxForPreview,
    projectLevel,
    isMember: async (userId, orgId) => (await memberRole(orgId, userId)) !== null,
    upstream,
  };
}
