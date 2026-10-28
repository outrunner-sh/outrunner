/**
 * An org's defaults for its members' new sessions
 * (20261030150000_org_defaults.sql): the model one starts on, and the size of
 * a new box. A member's own choice wins (lib/orgs/defaults.ts). And whether
 * a session is archived when the issue or pull request it works on closes
 * (20261102100000_github_agent_loop.sql; lib/github/loop.ts).
 *
 * The server's alone: the admin route has checked the caller is the org's
 * admin.
 */

import { orgDefaultsOrNone } from "@/lib/orgs/defaults";
import { isBoxSizeId, type BoxSizeId } from "@/lib/runtime/box-sizes";
import { type LoadoutEntry, parseLoadoutEntry } from "@/lib/runtime/model-loadout";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type OrgDefaults = { defaultModel: LoadoutEntry | null; boxSize: BoxSizeId | null; archiveOnClose: boolean };

export const NO_ORG_DEFAULTS: OrgDefaults = { defaultModel: null, boxSize: null, archiveOnClose: true };

/** The org's defaults; none for no org, or before the migration. */
export async function getOrgDefaults(orgId: string | undefined): Promise<OrgDefaults> {
  if (!orgId) return NO_ORG_DEFAULTS;
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_settings")
    // All of it: a column a later migration adds is read once it's there.
    .select("*")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error && probeStatus(error) === "missing") return NO_ORG_DEFAULTS;
  if (error) throw error;
  return {
    defaultModel: parseLoadoutEntry(data?.default_model),
    boxSize: isBoxSizeId(data?.box_size) ? data.box_size : null,
    archiveOnClose: data?.archive_on_close ?? true,
  };
}

/** The org's defaults for a session starting or a menu: none, said in the
 *  log, when they can't be read, rather than no session. */
export function orgDefaultsFor(orgId: string | undefined): Promise<OrgDefaults> {
  return orgDefaultsOrNone(() => getOrgDefaults(orgId), NO_ORG_DEFAULTS);
}

/** Set the org's defaults, as admin `by`; null clears one. Archiving on
 *  close is left as it is when not given. */
export async function setOrgDefaults(
  orgId: string,
  defaults: Omit<OrgDefaults, "archiveOnClose"> & { archiveOnClose?: boolean },
  by: string,
): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("organization_settings")
    .upsert(
      {
        org_id: orgId,
        default_model: defaults.defaultModel,
        box_size: defaults.boxSize,
        ...(defaults.archiveOnClose !== undefined && { archive_on_close: defaults.archiveOnClose }),
        updated_by: by,
      },
      { onConflict: "org_id" },
    );
  if (error) throw error;
}
