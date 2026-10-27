/**
 * The GitHub App's installations an org keeps (20261029100000): one org each.
 * The server's alone; the routes calling the writers have checked the caller
 * is the org's admin, or that GitHub sent the webhook.
 */

import type { Installation } from "@/lib/github/app";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type OrgInstallation = Installation & { installedBy: string | null; createdAt: string };

function toOrgInstallation(row: {
  installation_id: number;
  account_login: string;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
  suspended_at: string | null;
  installed_by: string | null;
  created_at: string;
}): OrgInstallation {
  return {
    id: row.installation_id,
    accountLogin: row.account_login,
    accountType: row.account_type,
    repositorySelection: row.repository_selection,
    suspended: row.suspended_at !== null,
    installedBy: row.installed_by,
    createdAt: row.created_at,
  };
}

/** An org's installations, by account. */
export async function listOrgInstallations(orgId: string): Promise<OrgInstallation[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("github_installations")
    .select("installation_id, account_login, account_type, repository_selection, suspended_at, installed_by, created_at")
    .eq("org_id", orgId)
    .order("account_login");
  if (error) throw error;
  return (data ?? []).map(toOrgInstallation);
}

/** The org an installation is kept by, or null when none keeps it. */
export async function installationOrg(installationId: number): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("github_installations")
    .select("org_id")
    .eq("installation_id", installationId)
    .maybeSingle();
  if (error) throw error;
  return data?.org_id ?? null;
}

/** Why an installation wasn't kept. */
export class InstallationTakenError extends Error {
  constructor() {
    super("Another Outrunner org has this GitHub account's installation. Uninstall it there first, or ask its admins.");
    this.name = "InstallationTakenError";
  }
}

/** Keep an installation for an org, or refresh it (its account, its
 *  repository choice, suspended or not). One org each: another org's is
 *  refused. */
export async function keepInstallation(orgId: string, installation: Installation, installedBy: string): Promise<void> {
  const owner = await installationOrg(installation.id);
  if (owner && owner !== orgId) throw new InstallationTakenError();
  const row = {
    org_id: orgId,
    account_login: installation.accountLogin,
    account_type: installation.accountType,
    repository_selection: installation.repositorySelection,
    suspended_at: installation.suspended ? new Date().toISOString() : null,
  };
  const supabase = createSupabaseAdminClient();
  const { error } = owner
    ? await supabase.from("github_installations").update(row).eq("installation_id", installation.id).eq("org_id", orgId)
    : await supabase
        .from("github_installations")
        .insert({ ...row, installation_id: installation.id, installed_by: installedBy });
  // Kept by another org at the same moment.
  if (error?.code === "23505") throw new InstallationTakenError();
  if (error) throw error;
}

/** Forget an installation (GitHub says it's gone, or the org's admin let it
 *  go); `orgId` when an admin asks, so it's only their org's. */
export async function forgetInstallation(installationId: number, orgId?: string): Promise<boolean> {
  let query = createSupabaseAdminClient().from("github_installations").delete().eq("installation_id", installationId);
  if (orgId) query = query.eq("org_id", orgId);
  const { data, error } = await query.select("installation_id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** Record GitHub suspending or unsuspending an installation. */
export async function setInstallationSuspended(installationId: number, suspended: boolean): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("github_installations")
    .update({ suspended_at: suspended ? new Date().toISOString() : null })
    .eq("installation_id", installationId);
  if (error) throw error;
}

/** Record what GitHub says changed about an installation's account or its
 *  repository choice. */
export async function updateInstallation(
  installationId: number,
  patch: { accountLogin?: string; repositorySelection?: "all" | "selected" },
): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("github_installations")
    .update({
      ...(patch.accountLogin && { account_login: patch.accountLogin }),
      ...(patch.repositorySelection && { repository_selection: patch.repositorySelection }),
    })
    .eq("installation_id", installationId);
  if (error) throw error;
}
