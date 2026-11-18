/**
 * Setup's reads and writes (lib/orgs/setup.ts holds the rule): what the
 * database says of an org, and its setup recorded as done
 * (organization_settings.setup_completed_at,
 * 20261119130000_org_setup.sql). The server's alone.
 */

import { getOrgContext } from "@/lib/orgs/server";
import { needsSetup, type OrgSetupState, type SetupGate, setupGate } from "@/lib/orgs/setup";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * What decides whether `orgId` needs setup. Before the migration that keeps
 * its completion, it reads as done: an org must never be sent through setup
 * because the database can't say otherwise.
 */
export async function readOrgSetupState(orgId: string): Promise<OrgSetupState> {
  const supabase = createSupabaseAdminClient();
  const [settings, workspaces, environments] = await Promise.all([
    supabase.from("organization_settings").select("setup_completed_at").eq("org_id", orgId).maybeSingle(),
    supabase.from("workspaces").select("id").eq("org_id", orgId).limit(1),
    // Only one someone made counts (setup.ts): one is enough to know.
    supabase
      .from("environments")
      .select("default_for_project_id")
      .eq("org_id", orgId)
      .is("archived_at", null)
      .is("default_for_project_id", null)
      .limit(1),
  ]);
  const status = probeStatus(settings.error);
  if (status === "missing" || status === "outdated") {
    return { setupCompletedAt: "before-migration", hasWorkspace: false, environments: [] };
  }
  if (settings.error) throw settings.error;
  if (workspaces.error) throw workspaces.error;
  if (environments.error) throw environments.error;
  return {
    setupCompletedAt: settings.data?.setup_completed_at ?? null,
    hasWorkspace: workspaces.data.length > 0,
    environments: environments.data.map((e) => ({ defaultForProjectId: e.default_for_project_id })),
  };
}

/**
 * What the signed-in user meets in the active org: setup (its admin), a
 * wait for an admin (a member), or nothing. Nothing whenever it can't be
 * read: a failed read must not send anyone through setup.
 */
export async function activeOrgSetupGate(): Promise<SetupGate> {
  try {
    const context = await getOrgContext();
    if (!context) return null;
    return setupGate(needsSetup(await readOrgSetupState(context.active.id)), context.active);
  } catch (error) {
    console.error("Could not read whether the org needs setup", error);
    return null;
  }
}

/** Record the org's setup as done (finished or skipped), by `by`: it's never
 *  shown again. The org's other settings are left as they are. */
export async function markOrgSetUp(orgId: string, by: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("organization_settings")
    .upsert({ org_id: orgId, setup_completed_at: new Date().toISOString(), updated_by: by }, { onConflict: "org_id" });
  if (error) throw error;
}

/** Whether the signed-in user is to be sent through the active org's setup
 *  (its admin, the org not set up): where a new user lands after sign-in,
 *  checkout or the desktop app's hand-off. A member waiting isn't. */
export async function mustSetUpActiveOrg(): Promise<boolean> {
  return (await activeOrgSetupGate())?.kind === "setup";
}
