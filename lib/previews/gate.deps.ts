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
import { previewUpstream } from "@/lib/previews/upstream";

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
    upstream: previewUpstream,
  };
}
