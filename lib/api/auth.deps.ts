/** The real reads behind lib/api/auth.ts. */

import type { ApiAuthDeps } from "@/lib/api/auth";
import { isOwner } from "@/lib/auth/owner";
import { findApiKey, findCliToken } from "@/lib/db/api-keys";
import { memberRole } from "@/lib/db/orgs";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { memberOrgId } from "@/lib/triage/caller";

/** Who may use Outrunner, asked of Auth at most once a minute per user: a
 *  script polling a session would otherwise ask on every call. */
const ALLOWED_TTL_MS = 60_000;
const allowedSeen = new Map<string, { allowed: boolean; at: number }>();

export const apiAuthDeps: ApiAuthDeps = {
  findKey: findApiKey,
  findCliToken,
  memberOrgId,
  memberRole,
  async allowed(userId) {
    const seen = allowedSeen.get(userId);
    if (seen && Date.now() - seen.at < ALLOWED_TTL_MS) return seen.allowed;
    const { data, error } = await createSupabaseAdminClient().auth.admin.getUserById(userId);
    const allowed = !error && data.user !== null && isOwner(data.user);
    if (allowedSeen.size > 5_000) allowedSeen.clear();
    allowedSeen.set(userId, { allowed, at: Date.now() });
    return allowed;
  },
};
