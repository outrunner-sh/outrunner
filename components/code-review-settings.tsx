"use client";

import { ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { SectionHeader } from "@/components/settings-details";
import { buttonVariants } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { type Installation, installationSettingsUrl } from "@/lib/github/installation";
import { requestJson } from "@/lib/http/request-json";
import type { Org } from "@/lib/orgs/active";

/**
 * Settings → Code review for the org the app is showing: the Outrunner GitHub
 * App's installations linked to it, and for its admins, installing the app
 * (app/api/github/app/install) and unlinking an installation.
 */
export function CodeReviewSettings({
  org,
  appSlug,
  installations,
  problem,
  linked,
}: {
  org: Org;
  /** Null when this deployment has no GitHub App set up. */
  appSlug: string | null;
  /** Null when they couldn't be read. */
  installations: Installation[] | null;
  problem: string | null;
  linked: string | null;
}) {
  const router = useRouter();
  const [unlinking, setUnlinking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const admin = org.role === "admin";

  const unlink = async (installationId: number) => {
    if (unlinking !== null) return;
    setUnlinking(installationId);
    setError(null);
    try {
      await requestJson(`/api/orgs/${org.id}/github-installations/${installationId}`, {
        method: "DELETE",
        fallback: "Couldn't unlink it. Try again.",
      });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't unlink it. Try again.");
    } finally {
      setUnlinking(null);
    }
  };

  return (
    <section className="space-y-6">
      <h1 className="text-lg font-semibold text-foreground">Code review</h1>
      <p className="max-w-prose text-sm text-muted-foreground">
        Outrunner reviews a pull request when it opens and each time it gets new commits, then posts as{" "}
        <span className="font-mono text-foreground/75">{appSlug ?? "outrunner"}[bot]</span>: comments on the lines it
        changed, and a summary with a score out of 5. It never approves, asks for changes, or pushes code.
      </p>

      {linked ? (
        <InlineMessage tone="info" actions={[{ label: "Dismiss", onClick: () => router.replace("/settings/code-review") }]}>
          Linked the Outrunner app on {linked}.
        </InlineMessage>
      ) : null}
      {problem ? (
        <InlineMessage tone="warning" actions={[{ label: "Dismiss", onClick: () => router.replace("/settings/code-review") }]}>
          {problem}
        </InlineMessage>
      ) : null}

      {appSlug === null ? (
        <p className="max-w-prose text-sm text-muted-foreground">
          The Outrunner GitHub App isn&apos;t set up on this deployment yet, so there&apos;s nothing to install.
        </p>
      ) : (
        <div className="space-y-3">
          <SectionHeader title="GitHub App" />
          {installations === null ? (
            <p className="text-sm text-muted-foreground">Couldn&apos;t load the app&apos;s installations. Reload the page to try again.</p>
          ) : installations.length === 0 ? (
            <p className="max-w-prose text-sm text-muted-foreground">
              Not installed for this org yet. Install it on the GitHub account that owns your repositories, and pick
              the repositories it may read and comment on.
            </p>
          ) : (
            <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 text-[13px]">
              {installations.map((installation) => (
                <li key={installation.installationId} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-foreground">{installation.accountLogin}</div>
                    <div className="text-xs text-muted-foreground">
                      {installation.accountType === "Organization" ? "Organization" : "Personal account"} ·{" "}
                      {installation.repositorySelection === "all" ? "All repositories" : "Selected repositories"}
                      {installation.suspended ? " · Suspended on GitHub" : ""}
                    </div>
                  </div>
                  <a
                    href={installationSettingsUrl(installation)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Configure on GitHub <ExternalLink className="size-3" />
                  </a>
                  {admin ? (
                    <LoadingButton
                      variant="outline"
                      size="sm"
                      status={unlinking === installation.installationId ? "pending" : "idle"}
                      labels={{ idle: "Unlink" }}
                      disabled={unlinking !== null}
                      onClick={() => void unlink(installation.installationId)}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {admin ? (
            <a
              href={`/api/github/app/install?org=${encodeURIComponent(org.id)}`}
              className={buttonVariants({ variant: "outline" })}
            >
              {installations?.length ? "Install on another account" : "Install on GitHub"}
            </a>
          ) : (
            <p className="text-xs text-muted-foreground">Only the org&apos;s admins can install or unlink the app.</p>
          )}
        </div>
      )}

      {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}
    </section>
  );
}
