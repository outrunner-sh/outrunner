/**
 * The Outrunner GitHub App's installations, linked to orgs
 * (supabase/migrations/20261028140000_github_app_installations.sql). The
 * table is the server's alone, so this reaches it with the service role; the
 * routes calling it check who may (an org admin links and unlinks; the app's
 * webhook, signed by GitHub, forgets and suspends).
 */

import type { Installation } from "@/lib/github/installation";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** An org's installations, oldest first. */
export async function listOrgInstallations(orgId: string): Promise<Installation[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("github_app_installations")
    .select("installation_id, account_login, account_type, repository_selection, suspended_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    installationId: Number(row.installation_id),
    accountLogin: row.account_login,
    accountType: row.account_type,
    repositorySelection: row.repository_selection,
    suspended: row.suspended_at !== null,
  }));
}

/** Link an installation to an org, or refresh what GitHub says of it when
 *  it's linked already. */
export async function linkInstallation(input: {
  orgId: string;
  installation: Installation;
  linkedBy: string;
}): Promise<void> {
  const { installation } = input;
  const now = new Date().toISOString();
  const { error } = await createSupabaseAdminClient()
    .from("github_app_installations")
    .upsert(
      {
        org_id: input.orgId,
        installation_id: installation.installationId,
        account_login: installation.accountLogin,
        account_type: installation.accountType,
        repository_selection: installation.repositorySelection,
        suspended_at: installation.suspended ? now : null,
        linked_by: input.linkedBy,
      },
      { onConflict: "org_id,installation_id" },
    );
  if (error) throw error;
}

/** Unlink an installation from one org. The app stays installed on GitHub. */
export async function unlinkInstallation(orgId: string, installationId: number): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("github_app_installations")
    .delete()
    .eq("org_id", orgId)
    .eq("installation_id", installationId)
    .select("installation_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** The app was uninstalled on GitHub: no org has it any more. */
export async function forgetInstallation(installationId: number): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("github_app_installations")
    .delete()
    .eq("installation_id", installationId);
  if (error) throw error;
}

/** Keep what GitHub says changed on an installation every org linked it:
 *  suspended or not, all repositories or selected ones. */
export async function updateInstallation(
  installationId: number,
  change: { suspended?: boolean; repositorySelection?: "all" | "selected" },
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await createSupabaseAdminClient()
    .from("github_app_installations")
    .update({
      ...(change.suspended === undefined ? {} : { suspended_at: change.suspended ? now : null }),
      ...(change.repositorySelection ? { repository_selection: change.repositorySelection } : {}),
    })
    .eq("installation_id", installationId);
  if (error) throw error;
}
