"use client";

import { ExternalLink, Github } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { type Installation, installationSettingsUrl } from "@/lib/github/installation";
import { requestJson } from "@/lib/http/request-json";
import type { Org } from "@/lib/orgs/active";
import { cn } from "@/lib/utils";

const PATH = "/automations";

/**
 * The Automations page for the org the app is showing: the Outrunner GitHub
 * App, whose events start the org's automations and which posts as
 * `outrunner[bot]` (its admins install it, app/api/github/app/install, and
 * unlink it), and the automations themselves.
 */
export function Automations({
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
  const dismiss = { label: "Dismiss", onClick: () => router.replace(PATH) };

  return (
    <div className="px-8 py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">Automations</h1>
          <p className="text-[13px] text-muted-foreground">
            Shared workflows for {org.personal ? "your personal org" : org.name}: a session that starts on its own,
            like a code review on every pull request.
          </p>
        </header>

        {linked ? (
          <InlineMessage tone="info" actions={[dismiss]}>
            Linked the Outrunner app on {linked}.
          </InlineMessage>
        ) : null}
        {problem ? (
          <InlineMessage tone="warning" actions={[dismiss]}>
            {problem}
          </InlineMessage>
        ) : null}

        <GitHubAppPanel org={org} appSlug={appSlug} installations={installations} />

        <section className="space-y-2">
          <h2 className="text-[13px] font-medium text-foreground">Automations</h2>
          <p className="rounded-lg border border-border/60 px-3 py-6 text-center text-[13px] text-muted-foreground">
            No automations yet.
          </p>
        </section>
      </div>
    </div>
  );
}

/** Whether the Outrunner GitHub App is installed for the org, on which
 *  accounts, and for its admins, Install and Unlink. */
function GitHubAppPanel({
  org,
  appSlug,
  installations,
}: {
  org: Org;
  appSlug: string | null;
  installations: Installation[] | null;
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

  const install = admin ? (
    <a
      href={`/api/github/app/install?org=${encodeURIComponent(org.id)}`}
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
    >
      {installations?.length ? "Install on another account" : "Install on GitHub"}
    </a>
  ) : null;

  return (
    <section className="space-y-2">
      <div className="overflow-hidden rounded-lg border border-border/60 text-[13px]">
        <div className="flex items-center gap-3 bg-muted/30 px-3 py-2.5">
          <Github className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-foreground">Outrunner GitHub App</div>
            <div className="text-xs text-muted-foreground">
              {appSlug === null
                ? "Not set up on this deployment yet, so there's nothing to install."
                : installations === null
                  ? "Couldn't load its installations. Reload the page to try again."
                  : installations.length === 0
                    ? `Install it on the GitHub account that owns your repositories. Automations post as ${appSlug}[bot].`
                    : `Automations post as ${appSlug}[bot] on the repositories it's installed on.`}
            </div>
          </div>
          {appSlug !== null && installations !== null ? install : null}
        </div>
        {installations?.length ? (
          <ul className="divide-y divide-border/60 border-t border-border/60">
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
        ) : null}
      </div>
      {appSlug !== null && !admin ? (
        <p className="text-xs text-muted-foreground">Only the org&apos;s admins can install or unlink the app.</p>
      ) : null}
      {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}
    </section>
  );
}
