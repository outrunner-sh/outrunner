"use client";

import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { GitHubIcon } from "@/components/brand-icons";
import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { InlineMessage } from "@/components/ui/notice";
import type { OrgInstallation } from "@/lib/db/github-installations";
import { requestJson } from "@/lib/http/request-json";
import type { Org } from "@/lib/orgs/active";

export type InstallationView = OrgInstallation & {
  /** Some of the repositories it reaches, by name. */
  repositories: string[];
  total: number;
  /** Whether Outrunner could reach it just now. */
  reachable: boolean;
};

/** What the setup route sends back, said for the page. */
const ERRORS: Record<string, string> = {
  not_configured: "The GitHub App isn't set up on this Outrunner yet.",
  not_admin: "Only the org's admins can install the GitHub App.",
  link_expired: "That install link has expired, or was someone else's. Start again from here.",
  not_yours: "GitHub says your account can't reach that installation. Sign in as the one who installed it.",
  no_installation: "GitHub has no such installation of the App. It may have been uninstalled.",
  taken: "Another Outrunner org has that GitHub account's installation. Uninstall it there first, or ask its admins.",
  failed: "Couldn't keep the installation. Try again.",
};

/** Where an installation is managed (its repositories, uninstalling) on GitHub. */
function manageUrl(i: OrgInstallation): string {
  return i.accountType === "Organization"
    ? `https://github.com/organizations/${i.accountLogin}/settings/installations/${i.id}`
    : `https://github.com/settings/installations/${i.id}`;
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
  installed,
  error,
}: {
  org: Org;
  configured: boolean;
  installations: InstallationView[];
  installed: string | null;
  error: string | null;
}) {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(error ? (ERRORS[error] ?? ERRORS.failed) : null);
  const [busy, setBusy] = useState<number | null>(null);
  const admin = org.role === "admin";

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
        <h1 className="text-lg font-semibold text-foreground">GitHub</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {`Install the Outrunner GitHub App on the GitHub accounts and organizations ${org.name} works in. Outrunner then reaches their repositories with the App, rather than each member's own GitHub sign-in.`}
        </p>
      </div>

      {installed ? (
        <InlineMessage tone="info">{`Installed on ${installed}.`}</InlineMessage>
      ) : null}
      {failure ? (
        <InlineMessage actions={[{ label: "Dismiss", onClick: () => setFailure(null) }]}>{failure}</InlineMessage>
      ) : null}

      {!configured ? (
        <p className="text-sm text-muted-foreground">The GitHub App isn&apos;t set up on this Outrunner yet.</p>
      ) : (
        <>
          {installations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not installed anywhere yet.</p>
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
                {`On GitHub, pick the account and which of its repositories Outrunner may reach. Removing it here stops ${org.name} using it; uninstall it on GitHub to take its access away there too.`}
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
