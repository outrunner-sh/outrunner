/**
 * An org's defaults for its members' new sessions
 * (20261030150000_org_defaults.sql): the model one starts on, and the size of
 * a new box. A member's own choice wins (lib/orgs/defaults.ts).
 *
 * The server's alone: the admin route has checked the caller is the org's
 * admin.
 */

import { isBoxSizeId, type BoxSizeId } from "@/lib/runtime/box-sizes";
import { type LoadoutEntry, parseLoadoutEntry } from "@/lib/runtime/model-loadout";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type OrgDefaults = { defaultModel: LoadoutEntry | null; boxSize: BoxSizeId | null };

export const NO_ORG_DEFAULTS: OrgDefaults = { defaultModel: null, boxSize: null };

/** The org's defaults; none for no org, or before the migration. */
export async function getOrgDefaults(orgId: string | undefined): Promise<OrgDefaults> {
  if (!orgId) return NO_ORG_DEFAULTS;
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_settings")
    .select("default_model, box_size")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error && probeStatus(error) === "missing") return NO_ORG_DEFAULTS;
  if (error) throw error;
  return {
    defaultModel: parseLoadoutEntry(data?.default_model),
    boxSize: isBoxSizeId(data?.box_size) ? data.box_size : null,
  };
}

/** Set the org's defaults, as admin `by`; null clears one. */
export async function setOrgDefaults(orgId: string, defaults: OrgDefaults, by: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("organization_settings")
    .upsert(
      { org_id: orgId, default_model: defaults.defaultModel, box_size: defaults.boxSize, updated_by: by },
      { onConflict: "org_id" },
    );
  if (error) throw error;
}
