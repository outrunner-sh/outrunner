/**
 * The org's `outrunner-connector` (supabase/migrations/20261031120000_org_connectors.sql):
 * the service user a team org's automations run as, made the first time one
 * runs. Its sessions are in no member's list, and it's paid by the
 * deployment, on its own plan and allowance (lib/billing/entitlements.ts).
 * A personal org has none: its automations run as its owner, whose org it is.
 */

import { connectorUserId } from "@/lib/automations/connector-id";
import { CONNECTOR_NAME } from "@/lib/automations/connector-name";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export { CONNECTOR_NAME, connectorUserId };

/** Its sign-in address: never mailed (the server signs in as it with a
 *  one-time token, lib/supabase/acting-user.ts). */
function connectorEmail(orgId: string): string {
  return `connector+${orgId}@noreply.outrunner.sh`;
}

/** The connectors seen: one per org, so bounded. Anyone else is asked again
 *  (one indexed lookup), and a user doesn't become one later. */
const known = new Map<string, true>();

/** Whether a user is an org's connector. */
export async function isConnector(userId: string): Promise<boolean> {
  if (known.has(userId)) return true;
  const { data, error } = await createSupabaseAdminClient()
    .from("org_connectors")
    .select("org_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (data) known.set(userId, true);
  return data !== null;
}

/** Of `userIds`, the connectors: kept off the Members page. */
export async function connectorsAmong(userIds: readonly string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const { data, error } = await createSupabaseAdminClient()
    .from("org_connectors")
    .select("user_id")
    .in("user_id", [...new Set(userIds)]);
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.user_id));
}

/**
 * The org's connector, made (a user, an admin of the org) the first time it's
 * asked for; null for a personal org, which takes no other member. Each step
 * is idempotent, by the connector's derived id: the user (made, or found
 * made), its membership, its record. So calls at once agree, and one that
 * died partway is finished by the next.
 */
export async function orgConnector(orgId: string): Promise<string | null> {
  const supabase = createSupabaseAdminClient();
  const { data: existing, error } = await supabase.from("org_connectors").select("user_id").eq("org_id", orgId).maybeSingle();
  if (error) throw error;
  if (existing) return existing.user_id;

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("personal_owner_id")
    .eq("id", orgId)
    .maybeSingle();
  if (orgError) throw orgError;
  if (!org || org.personal_owner_id) return null;

  const userId = connectorUserId(orgId);
  const { error: makeError } = await supabase.auth.admin.createUser({
    id: userId,
    email: connectorEmail(orgId),
    email_confirm: true,
    user_metadata: { full_name: CONNECTOR_NAME, user_name: CONNECTOR_NAME },
    // Let in where sign-up is restricted (lib/auth/allowlist.ts isAdmitted).
    app_metadata: { outrunner_admitted: true, outrunner_connector: true },
  });
  if (makeError) {
    // Made already (by a call at once, or one that died partway): it's ours.
    const { data: found } = await supabase.auth.admin.getUserById(userId);
    if (!found.user) throw makeError;
  }
  const { error: memberError } = await supabase
    .from("organization_members")
    .upsert({ org_id: orgId, user_id: userId, role: "admin" }, { onConflict: "org_id,user_id", ignoreDuplicates: true });
  if (memberError) throw memberError;
  const { error: linkError } = await supabase
    .from("org_connectors")
    .upsert({ org_id: orgId, user_id: userId }, { onConflict: "org_id", ignoreDuplicates: true });
  if (linkError) throw linkError;
  known.set(userId, true);
  return userId;
}
