"use client";

import { PageHeader } from "@/components/page-layout";

import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { GitHubIcon } from "@/components/brand-icons";
import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { InlineMessage } from "@/components/ui/notice";
import type { InstallationShare, OrgInstallation } from "@/lib/db/github-installations";
import { installationSettingsUrl } from "@/lib/github/listing";
import { requestJson } from "@/lib/http/request-json";
import type { Org } from "@/lib/orgs/active";

export type InstallationView = OrgInstallation & {
  /** Some of the repositories it reaches, by name. */
  repositories: string[];
  total: number;
  /** Whether Outrunner could reach it just now. */
  reachable: boolean;
  /** The other orgs it's shared with, for its source org's admins; null for
   *  anyone else. */
  shares: InstallationShare[] | null;
};

const AUTHORITY: Record<string, string> = {
  installer: "as its GitHub installer",
  account_owner: "as the GitHub account's owner",
  org_owner: "as a GitHub organization owner",
};

/** What the setup route sends back, said for the page. */
const ERRORS: Record<string, string> = {
  not_configured: "The GitHub App isn't set up on this Outrunner yet.",
  not_admin: "You must administer this org to connect an installation to it.",
  link_expired: "That install link has expired, or was someone else's. Start again from here.",
  not_installer:
    "Only whoever installed the App on GitHub, or an owner of the GitHub account or organization it's installed on, can connect it to an org. Ask them to add it here.",
  verify_declined:
    "Outrunner needs that one-time GitHub sign-in to confirm you installed the App. Install it again and allow it to finish.",
  no_installation:
    "Outrunner has no record of that installation from GitHub. If the App is still installed there, uninstall it on GitHub, then install it again from here.",
  failed: "Couldn't keep the installation. Try again.",
};

/** Where an installation is managed (its repositories, uninstalling) on GitHub. */
function manageUrl(i: OrgInstallation): string {
  return installationSettingsUrl({ installationId: i.id, login: i.accountLogin, type: i.accountType });
}

/**
 * Settings → Org → GitHub. The Outrunner GitHub App, installed on the GitHub
 * accounts and organizations whose repositories the org works on: Outrunner
 * reaches them with the App rather than each member's own sign-in.
 */
export function OrgGitHubSettings({
  org,
  configured,
  installations,
  available,
  pending,
  installed,
  error,
}: {
  org: Org;
  configured: boolean;
  installations: InstallationView[];
  /** Installations the admin may connect here, including shared ones. */
  available: OrgInstallation[];
  /** Back from GitHub before its word of the install: say to wait. */
  pending: boolean;
  installed: string | null;
  error: string | null;
}) {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(error ? (ERRORS[error] ?? ERRORS.failed) : null);
  const [busy, setBusy] = useState<number | null>(null);
  const admin = org.role === "admin";

  const claim = async (id: number) => {
    setBusy(id);
    setFailure(null);
    try {
      await requestJson(`/api/orgs/${org.id}/github/installations`, {
        method: "POST",
        body: { installationId: id },
        fallback: "Couldn't add it. Try again.",
      });
      router.refresh();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Couldn't add it. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const unshare = async (id: number, orgId: string) => {
    setBusy(id);
    setFailure(null);
    try {
      await requestJson(`/api/orgs/${org.id}/github/installations/${id}/shares/${orgId}`, {
        method: "DELETE",
        fallback: "Couldn't do that. Try again.",
      });
      router.refresh();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Couldn't do that. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const letGo = async (id: number) => {
    setBusy(id);
    setFailure(null);
    try {
      await requestJson(`/api/orgs/${org.id}/github/installations/${id}`, {
        method: "DELETE",
        fallback: "Couldn't do that. Try again.",
      });
      router.refresh();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Couldn't do that. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-8">
      <div className="space-y-1">
        <PageHeader title={"GitHub"} />
        <p className="max-w-prose text-sm text-muted-foreground">
          {`Connect the GitHub accounts and organizations ${org.name} works in. Multiple Outrunner organizations can share the same GitHub App installation.`}
        </p>
      </div>

      {installed ? (
        <InlineMessage tone="info">{`Installed on ${installed}.`}</InlineMessage>
      ) : null}
      {pending && available.length === 0 ? (
        <InlineMessage tone="info" actions={[{ label: "Reload", onClick: () => router.refresh() }]}>
          GitHub hasn&apos;t confirmed the installation yet. It shows here in a moment, for you to add. If it
          doesn&apos;t within a minute, uninstall the App on GitHub and install it again from here.
        </InlineMessage>
      ) : null}
      {admin && available.length > 0 ? (
        <div className="max-w-2xl space-y-2">
          <h2 className="text-[13px] font-medium text-foreground">Available GitHub connections</h2>
          <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
            {available.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-3 py-2">
                <GitHubIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{i.accountLogin}</span>
                <button
                  type="button"
                  className="route-state-button"
                  disabled={busy !== null}
                  onClick={() => void claim(i.id)}
                >
                  {`Add to ${org.name}`}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {failure ? (
        <InlineMessage actions={[{ label: "Dismiss", onClick: () => setFailure(null) }]}>{failure}</InlineMessage>
      ) : null}

      {!configured ? (
        <p className="text-sm text-muted-foreground">The GitHub App isn&apos;t set up on this Outrunner yet.</p>
      ) : (
        <>
          {installations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No GitHub accounts connected to this org yet.</p>
          ) : (
            <ul className="max-w-2xl divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
              {installations.map((i) => (
                <li key={i.id} className="space-y-2 px-3 py-3">
                  <div className="flex items-center gap-3">
                    <GitHubIcon className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-foreground">{i.accountLogin}</p>
                      <p className="text-xs text-muted-foreground">
                        {i.suspended
                          ? "Suspended on GitHub: unsuspend it there to use it again."
                          : !i.reachable
                            ? "Couldn't reach it just now."
                            : `${i.accountType === "Organization" ? "Organization" : "Account"} · ${
                                i.repositorySelection === "all" ? "all repositories" : `${i.total} selected ${i.total === 1 ? "repository" : "repositories"}`
                              }`}
                      </p>
                    </div>
                    {admin ? (
                      <a
                        href={manageUrl(i)}
                        target="_blank"
                        rel="noreferrer"
                        className="route-state-button gap-1.5"
                      >
                        Manage on GitHub <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                    {admin ? (
                      <HoldToConfirm
                        label="Remove"
                        disabled={busy !== null}
                        onConfirm={() => void letGo(i.id)}
                        className="h-7 px-2.5 text-xs"
                      />
                    ) : null}
                  </div>
                  {i.repositories.length > 0 ? (
                    <p className="pl-7 text-xs text-muted-foreground">
                      {i.repositories.join(", ")}
                      {i.total > i.repositories.length ? `, and ${i.total - i.repositories.length} more` : ""}
                    </p>
                  ) : null}
                  {admin && i.shares ? (
                    <div className="space-y-1 pl-7" data-testid={`shares-${i.id}`}>
                      <p className="text-xs font-medium text-foreground">
                        {i.shares.length === 0 ? `Not shared with any other Outrunner org.` : "Also shared with"}
                      </p>
                      {i.shares.length > 0 ? (
                        <ul className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/60">
                          {i.shares.map((s) => (
                            <li key={s.orgId} className="flex items-center gap-3 px-2.5 py-1.5">
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-xs text-foreground">
                                  {s.personal ? `${s.orgName} (personal org)` : s.orgName}
                                </p>
                                <p className="truncate text-[11px] text-muted-foreground">
                                  {`Connected ${new Date(s.linkedAt).toLocaleDateString()}${s.linkedByEmail ? ` by ${s.linkedByEmail}` : ""}${
                                    s.authority ? ` ${AUTHORITY[s.authority]}` : ""
                                  }`}
                                </p>
                              </div>
                              <HoldToConfirm
                                label="Stop sharing"
                                disabled={busy !== null}
                                onConfirm={() => void unshare(i.id, s.orgId)}
                                className="h-6 px-2 text-[11px]"
                              />
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {i.shares.length > 0 ? (
                        <p className="text-[11px] text-muted-foreground">
                          {`Removing ${i.accountLogin} from ${org.name} leaves ${
                            i.shares.length === 1 ? "this org" : "these orgs"
                          } connected, and no one can manage ${i.shares.length === 1 ? "it" : "them"} here until ${org.name} connects it again. Stop sharing first to cut ${
                            i.shares.length === 1 ? "it" : "them"
                          } off too.`}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {admin ? (
            <div className="space-y-2">
              <a href="/api/github/app/install" className="route-state-button inline-flex gap-1.5">
                <GitHubIcon className="size-3.5" />
                {installations.length === 0 ? "Install the GitHub App" : "Install on another account"}
              </a>
              <p className="text-xs text-muted-foreground">
                {`On GitHub, pick the account and repositories Outrunner may reach. Removing it here only disconnects ${org.name}; other Outrunner organizations keep their connections. Uninstalling it on GitHub removes access for every connected organization.`}
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Only the org&apos;s admins install the GitHub App.</p>
          )}
        </>
      )}
    </section>
  );
}
