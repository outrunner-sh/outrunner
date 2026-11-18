"use client";

import Link from "next/link";

import { GitHubReconnectLink } from "@/components/github-reconnect-link";
import { InlineMessage } from "@/components/ui/notice";
import type { Listing, PickerError } from "@/lib/client/repository-listing";
import type { CodeProvider } from "@/lib/code-providers/repository";
import { installationSettingsUrl, type SourceAccount } from "@/lib/github/listing";

// Where a user reviews which organizations an OAuth app may see.
const GITHUB_APP_ACCESS_URL = "https://github.com/settings/applications";

/** Where the list comes from, in an org with the GitHub App: its
 *  installations, and where to give the App more repositories. */
export function AppSourceNote({ accounts, className }: { accounts: SourceAccount[]; className?: string }) {
  const suspended = accounts.filter((a) => a.suspended).map((a) => a.login);
  const only = accounts.length === 1 ? accounts[0] : null;
  return (
    <p className={className ?? "text-muted-foreground border-border shrink-0 border-t px-3 py-2 text-xs"}>
      {`From Outrunner's GitHub App on ${accounts.map((a) => a.login).join(", ")}. `}
      {suspended.length > 0 && `It's suspended on ${suspended.join(", ")}. `}
      {only ? (
        <a href={installationSettingsUrl(only)} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
          Add repositories
        </a>
      ) : (
        <Link href="/settings/org/github" className="text-foreground underline underline-offset-2">
          Add repositories
        </Link>
      )}
    </p>
  );
}

/** Where to give the App a repository it can't reach: its owner's
 *  installation on GitHub, or the org's GitHub settings. */
function appAccessAction(source: { accounts: SourceAccount[] }, repo: string | undefined) {
  const owner = repo?.split("/")[0]?.toLowerCase();
  const account = source.accounts.find((a) => a.login.toLowerCase() === owner);
  return account
    ? { label: "Add it on GitHub", href: installationSettingsUrl(account), external: true }
    : { label: "Settings → Org → GitHub", href: "/settings/org/github" };
}

/** A picker's failure: GitHub withholding a repository (and where to give
 *  access), a token to sign in again, or what the server said. */
export function PickerErrorMessage({ error, listing, provider }: { error: PickerError; listing: Listing | null; provider: CodeProvider }) {
  return (
    <>
      {error.repo && <p className="mb-1 truncate font-mono text-xs">{error.repo}</p>}
      <InlineMessage
        tone={error.noAccess ? "warning" : "error"}
        actions={
          error.noAccess
            ? listing?.source.kind === "app"
              ? [appAccessAction(listing.source, error.repo)]
              : [{ label: "Grant access on GitHub", href: GITHUB_APP_ACCESS_URL, external: true }]
            : undefined
        }
      >
        {error.noAccess
          ? listing?.source.kind === "app"
            ? "Outrunner's GitHub App can't reach it. Add it to the App's repositories on GitHub."
            : "GitHub isn't giving Outrunner access to it. If an organization owns it, an owner may need to approve Outrunner."
          : error.message}
        {provider === "github" && error.reconnect && <GitHubReconnectLink />}
        {provider === "gitlab" && (
          <Link href="/settings/connections" className="ml-1 underline">
            Connect GitLab
          </Link>
        )}
      </InlineMessage>
    </>
  );
}
