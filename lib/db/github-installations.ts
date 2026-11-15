/** Global GitHub installation metadata and independent organization links.
 * Only trusted server routes and signed GitHub webhooks call these helpers. */

import { githubAppConfig, installationToken, type Installation } from "@/lib/github/app";
import { listInstallationRepositoryRecords } from "@/lib/github/client";
import { refreshConnectedGitHubNames, type ConnectedGitHubProject, type GitHubRepositoryName } from "@/lib/github/project-renames";
import { appOwnership, type GitHubOwnership, linkIdentity } from "@/lib/github/installation-owner";
import { isUuid } from "@/lib/ids";
import type { GithubLinkAuthority } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type OrgInstallation = Installation & { suspended: boolean; installedBy: string | null; createdAt: string };

type Row = {
  installation_id: number;
  connected_org_ids: string[];
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
  "installation_id, account_login, account_type, repository_selection, suspended_at, installed_by, installer_id, installer_login, created_at, connected_org_ids";

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
    .from("org_github_installation_details")
    .select(COLUMNS)
    .eq("org_id", orgId)
    .order("account_login");
  if (error) throw error;
  return ((data ?? []) as Row[]).map(toOrgInstallation);
}

/** Installations this admin might connect here: those they installed, and
 * those used by another org they administer. Connecting still needs GitHub's
 * say (claimInstallation): administering another org grants nothing. Never
 * expose other organizations' names. */
export async function listAvailableFor(githubId: number | null, orgId: string, userId: string): Promise<OrgInstallation[]> {
  if (!isUuid(orgId)) return [];
  const supabase = createSupabaseAdminClient();
  const { data: memberships, error: membershipError } = await supabase.from("organization_members")
    .select("org_id").eq("user_id", userId).eq("role", "admin");
  if (membershipError) throw membershipError;
  const administered = new Set((memberships ?? []).map((m) => m.org_id));
  if (!administered.has(orgId)) return [];
  const [installed, shared] = await Promise.all([
    githubId
      ? supabase.from("github_installations").select("*").eq("installer_id", githubId)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("org_github_installation_details").select(COLUMNS).in("org_id", [...administered]),
  ]);
  if (installed.error) throw installed.error;
  if (shared.error) throw shared.error;
  const candidates = new Map<number, Row>([
    ...(installed.data ?? []).map((i) => [i.installation_id, { ...i, installed_by: null }] as const),
    ...(shared.data ?? []).map((i) => [i.installation_id, i] as const),
  ]);
  if (candidates.size === 0) return [];
  const { data: links, error: linksError } = await supabase.from("org_github_installations")
    .select("installation_id, org_id").in("installation_id", [...candidates.keys()]);
  if (linksError) throw linksError;
  return [...candidates.values()]
    .filter((i) => !(links ?? []).some((l) => l.installation_id === i.installation_id && l.org_id === orgId))
    .sort((a, b) => a.account_login.localeCompare(b.account_login))
    .map(toOrgInstallation);
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

/** Why an installation wasn't claimed. */
export type ClaimRefusal = "unknown" | "not_installer" | "not_admin";

export class ClaimError extends Error {
  readonly reason: ClaimRefusal;

  constructor(reason: ClaimRefusal) {
    super(reason);
    this.name = "ClaimError";
    this.reason = reason;
  }
}

/** Connect without moving or replacing any other organization's link.
 * GitHub must vouch for it: one of the user's GitHub accounts (their
 * sign-in's, the one they connected; each verified by GitHub) is the
 * installer, or owns the installation's account (lib/github/
 * installation-owner.ts). The database checks the destination's
 * administration and the installer, and records how it was authorized. */
export async function claimInstallation(input: {
  orgId: string;
  installation: Installation;
  githubIds: Array<number | null | undefined>;
  userId: string;
  /** Whether GitHub says this GitHub user owns the installation's account;
   *  asked of GitHub as the App when not given. */
  ownership?: (githubId: number) => Promise<GitHubOwnership | null>;
}): Promise<void> {
  if (!isUuid(input.orgId)) throw new ClaimError("unknown");
  const holder = await installationHolder(input.installation.id);
  if (!holder) throw new ClaimError("unknown");
  if (!holder.orgIds.includes(input.orgId)) {
    const config = input.ownership ? null : githubAppConfig();
    const ownership = input.ownership ?? (config ? appOwnership(config, input.installation) : async () => null);
    const identity = await linkIdentity(input.githubIds, holder.installerId, ownership);
    const { data, error } = await createSupabaseAdminClient().rpc("link_github_installation", {
      target_org: input.orgId,
      target_installation: input.installation.id,
      github_user_id: identity.githubId,
      actor_id: input.userId,
      verified_owner: identity.verifiedOwner,
    });
    if (error) throw error;
    if (data) throw new ClaimError(data as ClaimRefusal);
  }
  await refreshInstallation(input.orgId, input.installation);
}

/** Another org an installation is shared with, as its source org sees it. */
export type InstallationShare = {
  orgId: string;
  orgName: string;
  personal: boolean;
  linkedAt: string;
  linkedBy: string | null;
  linkedByEmail: string | null;
  /** How GitHub authorized it; null for one made before that was recorded. */
  authority: GithubLinkAuthority | null;
};

/** The other orgs the installation is shared with, or null when this org
 * isn't its source (the first org it was connected to, while still connected):
 * only the source sees them. */
export async function listInstallationShares(orgId: string, installationId: number): Promise<InstallationShare[] | null> {
  if (!isUuid(orgId)) return null;
  const supabase = createSupabaseAdminClient();
  const { data: source, error: sourceError } = await supabase.rpc("github_installation_source", { target_installation: installationId });
  if (sourceError) throw sourceError;
  if (source !== orgId) return null;
  const { data, error } = await supabase.rpc("github_installation_shares", { source_org: orgId, target_installation: installationId });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    orgId: r.org_id,
    orgName: r.org_name,
    personal: r.personal,
    linkedAt: r.linked_at,
    linkedBy: r.linked_by,
    linkedByEmail: r.linked_by_email,
    authority: r.authority,
  }));
}

/** Why a share wasn't removed. */
export type ShareRefusal = "not_source" | "not_shared";

/** Disconnect another org from this org's installation, as its source org. */
export async function removeInstallationShare(orgId: string, installationId: number, targetOrgId: string): Promise<ShareRefusal | null> {
  if (!isUuid(orgId) || !isUuid(targetOrgId)) return "not_shared";
  const { data, error } = await createSupabaseAdminClient().rpc("remove_github_installation_share", {
    source_org: orgId,
    target_installation: installationId,
    target_org: targetOrgId,
  });
  if (error) throw error;
  return (data as ShareRefusal | null) ?? null;
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
  if (!installation.suspendedAt) await refreshInstallationProjectNames(installation.id);
  return true;
}

/** Keep connected projects in step with GitHub after a rename or transfer.
 * A reconnect refreshes the installation AND its existing projects. Signed
 * repository webhooks may supply the changed name directly; other callers
 * read the installation's repositories from GitHub. Never creates projects,
 * changes project ownership or grants, or reaches outside this installation's org links. */
export async function refreshInstallationProjectNames(
  installationId: number,
  changed?: readonly GitHubRepositoryName[],
): Promise<number> {
  const holder = await installationHolder(installationId);
  if (!holder || holder.orgIds.length === 0) return 0;
  let repositories = changed;
  if (!repositories) {
    const config = githubAppConfig();
    if (!config) throw new Error("The GitHub App isn't configured.");
    const token = await installationToken(config, installationId);
    repositories = (await listInstallationRepositoryRecords(token)).repositories;
  }
  const db = createSupabaseAdminClient();
  return refreshConnectedGitHubNames(holder.orgIds, repositories, {
    projects: async (orgIds) => {
      const projects: ConnectedGitHubProject[] = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await db.from("projects")
          .select("id, org_id, github_repo_id, full_name").in("org_id", [...orgIds])
          .order("id").range(offset, offset + 999);
        if (error) throw error;
        projects.push(...(data ?? []).map((project) => ({
          id: project.id, orgId: project.org_id,
          githubRepoId: project.github_repo_id, fullName: project.full_name,
        })));
        if ((data?.length ?? 0) < 1000) return projects;
      }
    },
    rename: async (project, canonical) => {
      const { data, error } = await db.from("projects").update({
        full_name: canonical.fullName,
        owner: canonical.owner,
        name: canonical.name,
        html_url: canonical.htmlUrl,
      }).eq("id", project.id).eq("org_id", project.orgId)
        .eq("github_repo_id", project.githubRepoId!).select("id");
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    },
  });
}

/** Forget an installation: GitHub says it was uninstalled. */
export async function forgetInstallation(installationId: number): Promise<void> {
  const { error } = await createSupabaseAdminClient().from("github_installations").delete().eq("installation_id", installationId);
  if (error) throw error;
}

/** Disconnect only this org. The installation and all other orgs keep access. */
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
