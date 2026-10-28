/**
 * The org's `outrunner-connector` (supabase/migrations/20261031120000_org_connectors.sql):
 * the service user a team org's automations run as, made the first time one
 * runs. Its sessions are in no member's list, and it's paid by the
 * deployment, on its own plan and allowance (lib/billing/entitlements.ts).
 * A personal org has none: its automations run as its owner, whose org it is.
 */

import { CONNECTOR_NAME } from "@/lib/automations/connector-name";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export { CONNECTOR_NAME };

/** Its sign-in address: never mailed (the server signs in as it with a
 *  one-time token, lib/supabase/acting-user.ts). */
function connectorEmail(orgId: string): string {
  return `connector+${orgId}@noreply.outrunner.sh`;
}

const known = new Map<string, boolean>();

/** Whether a user is an org's connector; kept once known, as it never
 *  changes for a user. */
export async function isConnector(userId: string): Promise<boolean> {
  const kept = known.get(userId);
  if (kept !== undefined) return kept;
  const { data, error } = await createSupabaseAdminClient()
    .from("org_connectors")
    .select("org_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  known.set(userId, data !== null);
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
 * asked for; null for a personal org, which takes no other member. Two at once
 * make one: the loser's user is deleted.
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

  const { data: made, error: makeError } = await supabase.auth.admin.createUser({
    email: connectorEmail(orgId),
    email_confirm: true,
    user_metadata: { full_name: CONNECTOR_NAME, user_name: CONNECTOR_NAME },
    // Let in where sign-up is restricted (lib/auth/allowlist.ts isAdmitted).
    app_metadata: { outrunner_admitted: true, outrunner_connector: true },
  });
  if (makeError || !made.user) {
    // Made already by a call that lost its insert below, say: find it.
    const raced = await supabase.from("org_connectors").select("user_id").eq("org_id", orgId).maybeSingle();
    if (raced.data) return raced.data.user_id;
    throw makeError ?? new Error("Couldn't make the org's connector.");
  }
  const userId = made.user.id;
  const { error: memberError } = await supabase
    .from("organization_members")
    .insert({ org_id: orgId, user_id: userId, role: "admin" });
  if (memberError) {
    await supabase.auth.admin.deleteUser(userId).catch(() => undefined);
    throw memberError;
  }
  const { error: linkError } = await supabase.from("org_connectors").insert({ org_id: orgId, user_id: userId });
  if (linkError) {
    // Another call made the org's connector first: use it, drop this one.
    await supabase.auth.admin.deleteUser(userId).catch(() => undefined);
    const winner = await supabase.from("org_connectors").select("user_id").eq("org_id", orgId).maybeSingle();
    if (winner.data) return winner.data.user_id;
    throw linkError;
  }
  known.set(userId, true);
  return userId;
}
