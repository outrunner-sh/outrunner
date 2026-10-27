/**
 * The GitHub App's installations (20261029100000, 20261029110000). GitHub's
 * webhook records each new one unclaimed, with who installed it (the event's
 * sender); that GitHub user claims it for an org they administer, and from
 * then it's that org's (one org each). The server's alone; the routes have
 * checked the caller is the org's admin, or that GitHub sent the webhook.
 */

import type { Installation } from "@/lib/github/app";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type OrgInstallation = Installation & { suspended: boolean; installedBy: string | null; createdAt: string };

type Row = {
  installation_id: number;
  org_id: string | null;
  account_login: string;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
  suspended_at: string | null;
  installed_by: string | null;
  installer_login: string | null;
  created_at: string;
};

const COLUMNS =
  "installation_id, org_id, account_login, account_type, repository_selection, suspended_at, installed_by, installer_login, created_at";

function toOrgInstallation(row: Row): OrgInstallation {
  return {
    id: row.installation_id,
    accountLogin: row.account_login,
    accountType: row.account_type,
    repositorySelection: row.repository_selection,
    suspendedAt: row.suspended_at,
    suspended: row.suspended_at !== null,
    installedBy: row.installed_by,
    createdAt: row.created_at,
  };
}

/** An org's installations, by account. */
export async function listOrgInstallations(orgId: string): Promise<OrgInstallation[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("github_installations")
    .select(COLUMNS)
    .eq("org_id", orgId)
    .order("account_login");
  if (error) throw error;
  return ((data ?? []) as Row[]).map(toOrgInstallation);
}

/** Installations no org has claimed that `githubLogin` installed: theirs to
 *  claim. */
export async function listUnclaimedFor(githubLogin: string): Promise<OrgInstallation[]> {
  if (!githubLogin) return [];
  const { data, error } = await createSupabaseAdminClient()
    .from("github_installations")
    .select(COLUMNS)
    .is("org_id", null)
    .ilike("installer_login", githubLogin.replace(/[\\%_]/g, (c) => `\\${c}`))
    .order("account_login");
  if (error) throw error;
  return ((data ?? []) as Row[]).map(toOrgInstallation);
}

/** Who has an installation: the org that claimed it (null: none yet), and
 *  who installed it; null when Outrunner hasn't heard of it. */
export async function installationHolder(
  installationId: number,
): Promise<{ orgId: string | null; installerLogin: string | null } | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("github_installations")
    .select("org_id, installer_login")
    .eq("installation_id", installationId)
    .maybeSingle();
  if (error) throw error;
  return data ? { orgId: data.org_id, installerLogin: data.installer_login } : null;
}

/** Record a new installation, unclaimed, with who installed it (the webhook's
 *  sender). One heard of already is left as it is. */
export async function recordInstalled(installation: Installation, installerLogin: string): Promise<void> {
  const { error } = await createSupabaseAdminClient().from("github_installations").upsert(
    {
      installation_id: installation.id,
      account_login: installation.accountLogin,
      account_type: installation.accountType,
      repository_selection: installation.repositorySelection,
      suspended_at: installation.suspendedAt,
      installer_login: installerLogin,
    },
    { onConflict: "installation_id", ignoreDuplicates: true },
  );
  if (error) throw error;
}

/** Why an installation wasn't claimed. */
export type ClaimRefusal = "unknown" | "taken" | "not_installer";

export class ClaimError extends Error {
  readonly reason: ClaimRefusal;

  constructor(reason: ClaimRefusal) {
    super(reason);
    this.name = "ClaimError";
    this.reason = reason;
  }
}

/**
 * Claim an unclaimed installation for an org, as the GitHub user who
 * installed it, in one step: no one else can, and two claims can't both
 * land. Refreshed from `installation` (GitHub's word, asked just now).
 */
export async function claimInstallation(input: {
  orgId: string;
  installation: Installation;
  githubLogin: string;
  userId: string;
}): Promise<void> {
  const { data, error } = await createSupabaseAdminClient()
    .from("github_installations")
    .update({
      org_id: input.orgId,
      installed_by: input.userId,
      account_login: input.installation.accountLogin,
      account_type: input.installation.accountType,
      repository_selection: input.installation.repositorySelection,
      suspended_at: input.installation.suspendedAt,
    })
    .eq("installation_id", input.installation.id)
    .is("org_id", null)
    .ilike("installer_login", input.githubLogin.replace(/[\\%_]/g, (c) => `\\${c}`))
    .select("installation_id");
  if (error) throw error;
  if (data?.length) return;
  const holder = await installationHolder(input.installation.id);
  if (!holder) throw new ClaimError("unknown");
  if (holder.orgId === input.orgId) return;
  throw new ClaimError(holder.orgId ? "taken" : "not_installer");
}

/** Refresh an org's installation from GitHub's word; false when the org
 *  doesn't have it (any more). */
export async function refreshInstallation(orgId: string, installation: Installation): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("github_installations")
    .update({
      account_login: installation.accountLogin,
      account_type: installation.accountType,
      repository_selection: installation.repositorySelection,
      suspended_at: installation.suspendedAt,
    })
    .eq("installation_id", installation.id)
    .eq("org_id", orgId)
    .select("installation_id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
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

/** Record GitHub suspending (when) or unsuspending (null) an installation. */
export async function setInstallationSuspended(installationId: number, suspendedAt: string | null): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("github_installations")
    .update({ suspended_at: suspendedAt })
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
