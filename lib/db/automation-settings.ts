/**
 * An org's settings for all its automations (organization_settings,
 * 20261114130000_automation_cover_new_repos.sql): whether they run on their
 * runner's default model and coding agent rather than Outrunner's models.
 *
 * The server's alone: the route has checked the caller is the org's admin.
 */

import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type AutomationSettings = { onHarness: boolean };

/** The org's automation settings: Outrunner's models before the migration,
 *  or with none saved. */
export async function getAutomationSettings(orgId: string): Promise<AutomationSettings> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_settings")
    .select("automations_on_harness")
    .eq("org_id", orgId)
    .maybeSingle();
  // Before the migration (the table, or its column, not there yet):
  // Outrunner's models, as with none saved. Any other error is thrown.
  const status = probeStatus(error);
  if (status === "missing" || status === "outdated") return { onHarness: false };
  if (error) throw error;
  return { onHarness: data?.automations_on_harness ?? false };
}

/** For a page's copy: Outrunner's models, said in the log, when they can't
 *  be read, rather than no page. */
export function automationSettingsOrDefault(orgId: string): Promise<AutomationSettings> {
  return getAutomationSettings(orgId).catch((error: unknown) => {
    console.error(`Could not read org ${orgId}'s automation settings`, error);
    return { onHarness: false };
  });
}

/** Set them, as admin `by`; the org's other settings are left as they are. */
export async function setAutomationSettings(orgId: string, settings: AutomationSettings, by: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("organization_settings")
    .upsert(
      { org_id: orgId, automations_on_harness: settings.onHarness, updated_by: by },
      { onConflict: "org_id" },
    );
  if (error) throw error;
}
