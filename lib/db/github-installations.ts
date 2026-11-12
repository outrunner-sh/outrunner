/** Global GitHub installation metadata and independent organization links.
 * Only trusted server routes and signed GitHub webhooks call these helpers. */

import type { Installation } from "@/lib/github/app";
import { isUuid } from "@/lib/ids";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type OrgInstallation = Installation & {
  suspended: boolean;
  installedBy: string | null;
  createdAt: string;
  /** Shared into this org by an admin of another connected org: it lasts
   *  while they administer that org and it stays connected. */
  shared: boolean;
};

type Row = {
  installation_id: number;
  connected_org_ids: string[];
  root_org_ids: string[];
  shared_from_org: string | null;
  account_login: string;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
  suspended_at: string | null;
  installed_by: string | null;
  installer_id: number | null;
  installer_login: string | null;
  created_at: string;
};

const COLUMNS =
  "installation_id, account_login, account_type, repository_selection, suspended_at, installed_by, installer_id, installer_login, created_at, connected_org_ids, root_org_ids, shared_from_org";

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
    shared: row.shared_from_org !== null,
  };
}

/** An org's installations, by account. */
export async function listOrgInstallations(orgId: string): Promise<OrgInstallation[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("org_github_installation_details")
    .select(COLUMNS)
    .eq("org_id", orgId)
    .order("account_login");
  if (error) throw error;
  return ((data ?? []) as Row[]).map(toOrgInstallation);
}

/** Installations this admin may connect to `orgId`, as link_github_installation
 * decides: their own as GitHub's verified installer (a first connection, or
 * any time on a GitHub user account, which only its owner can install on),
 * one this org held directly before, or, for a team org, a share from
 * another connected org they administer. Never other organizations' names. */
export async function listAvailableFor(githubId: number | null, orgId: string, userId: string): Promise<OrgInstallation[]> {
  if (!isUuid(orgId)) return [];
  const supabase = createSupabaseAdminClient();
  const [{ data: memberships, error: membershipError }, { data: org, error: orgError }] = await Promise.all([
    supabase.from("organization_members").select("org_id").eq("user_id", userId).eq("role", "admin"),
    supabase.from("organizations").select("personal_owner_id").eq("id", orgId).maybeSingle(),
  ]);
  if (membershipError) throw membershipError;
  if (orgError) throw orgError;
  const administered = new Set((memberships ?? []).map((m) => m.org_id));
  if (!administered.has(orgId) || !org) return [];
  const personal = org.personal_owner_id !== null;
  const [installed, shared, previous] = await Promise.all([
    githubId
      ? supabase.from("github_installations").select("*").eq("installer_id", githubId)
      : Promise.resolve({ data: [], error: null }),
    personal
      ? Promise.resolve({ data: [], error: null })
      : supabase.from("org_github_installation_details").select(COLUMNS).in("org_id", [...administered]),
    supabase.from("github_installations").select("*").contains("root_org_ids", [orgId]),
  ]);
  if (installed.error) throw installed.error;
  if (shared.error) throw shared.error;
  if (previous.error) throw previous.error;
  // Not (yet) linked here: no link's own columns.
  const unlinked = (i: Omit<Row, "installed_by" | "shared_from_org">): Row => ({ ...i, installed_by: null, shared_from_org: null });
  const candidates = new Map<number, Row>([
    ...(installed.data ?? []).map((i) => [i.installation_id, unlinked(i)] as const),
    ...(previous.data ?? []).map((i) => [i.installation_id, unlinked(i)] as const),
    ...((shared.data ?? []) as Row[]).map((i) => [i.installation_id, i] as const),
  ]);
  if (candidates.size === 0) return [];
  const { data: links, error: linksError } = await supabase.from("org_github_installations")
    .select("installation_id, org_id").in("installation_id", [...candidates.keys()]);
  if (linksError) throw linksError;
  return [...candidates.values()].filter((i) => {
    const connected = (links ?? []).filter((l) => l.installation_id === i.installation_id);
    if (connected.some((l) => l.org_id === orgId)) return false;
    const installer = githubId !== null && i.installer_id === githubId
      && (i.connected_org_ids.length === 0 || i.account_type === "User");
    return installer
      || i.root_org_ids.includes(orgId)
      || (!personal && connected.some((l) => administered.has(l.org_id)));
  }).sort((a, b) => a.account_login.localeCompare(b.account_login)).map(toOrgInstallation);
}

/** All linked organizations, plus the original GitHub installer. */
export async function installationHolder(
  installationId: number,
): Promise<{ orgIds: string[]; installerId: number | null } | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("github_installations")
    .select("installer_id").eq("installation_id", installationId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: links, error: linksError } = await supabase.from("org_github_installations")
    .select("org_id").eq("installation_id", installationId);
  if (linksError) throw linksError;
  return { orgIds: (links ?? []).map((l) => l.org_id), installerId: data.installer_id };
}

/** Record a new installation, unclaimed, with who installed it (the webhook's
 *  sender). One heard of already is left as it is. */
export async function recordInstalled(
  installation: Installation,
  installer: { id: number; login: string },
): Promise<void> {
  const { error } = await createSupabaseAdminClient().from("github_installations").upsert(
    {
      installation_id: installation.id,
      account_login: installation.accountLogin,
      account_type: installation.accountType,
      repository_selection: installation.repositorySelection,
      suspended_at: installation.suspendedAt,
      installer_id: installer.id,
      installer_login: installer.login,
    },
    { onConflict: "installation_id", ignoreDuplicates: true },
  );
  if (error) throw error;
}

/** Why an installation wasn't claimed. `personal_org`: a personal org can't
 *  take a share of another org's installation. */
export type ClaimRefusal = "unknown" | "not_installer" | "not_admin" | "personal_org";

export class ClaimError extends Error {
  readonly reason: ClaimRefusal;

  constructor(reason: ClaimRefusal) {
    super(reason);
    this.name = "ClaimError";
    this.reason = reason;
  }
}

/** Connect without moving or replacing any other organization's link.
 * The database decides (link_github_installation): GitHub's verified
 * installer, an org reconnecting its own earlier link, or a share from an
 * org the admin administers into a team org, revoked when they stop. */
export async function claimInstallation(input: {
  orgId: string;
  installation: Installation;
  githubId: number | null;
  userId: string;
}): Promise<void> {
  if (!isUuid(input.orgId)) throw new ClaimError("unknown");
  const { data, error } = await createSupabaseAdminClient().rpc("link_github_installation", {
    target_org: input.orgId,
    target_installation: input.installation.id,
    github_user_id: input.githubId,
    actor_id: input.userId,
  });
  if (error) throw error;
  if (data) throw new ClaimError(data as ClaimRefusal);
  await refreshInstallation(input.orgId, input.installation);
}

/** Refresh an org's installation from GitHub's word; false when the org
 *  doesn't have it (any more). */
export async function refreshInstallation(orgId: string, installation: Installation): Promise<boolean> {
  const links = await listOrgInstallations(orgId);
  if (!links.some((i) => i.id === installation.id)) return false;
  const { error } = await createSupabaseAdminClient().from("github_installations").update({
    account_login: installation.accountLogin,
    account_type: installation.accountType,
    repository_selection: installation.repositorySelection,
    suspended_at: installation.suspendedAt,
  }).eq("installation_id", installation.id);
  if (error) throw error;
  return true;
}

/** Forget an installation: GitHub says it was uninstalled. */
export async function forgetInstallation(installationId: number): Promise<void> {
  const { error } = await createSupabaseAdminClient().from("github_installations").delete().eq("installation_id", installationId);
  if (error) throw error;
}

/** Disconnect only this org. The installation and other orgs keep access,
 *  except the shares made from this org's link, which go with it. */
export async function unclaimInstallation(installationId: number, orgId: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient().from("org_github_installations")
    .delete().eq("installation_id", installationId).eq("org_id", orgId).select("installation_id");
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
