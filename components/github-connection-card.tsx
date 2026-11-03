"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { GitHubIcon } from "@/components/brand-icons";
import { GitHubConnectLink } from "@/components/github-connect-link";
import { SectionHeader } from "@/components/settings-details";
import { InlineMessage } from "@/components/ui/notice";
import { requestJson } from "@/lib/http/request-json";
import { cn } from "@/lib/utils";

/** What the GitHub card shows (components/github-connection-section.tsx):
 *  nothing secret. */
export type GitHubCardView = {
  /** Users can connect through the App here (its client secret is set). */
  configured: boolean;
  /** The GitHub login they sign in with, if they do. */
  signInLogin: string | null;
  connection: {
    login: string;
    broken: boolean;
    accessExpiresAt: string | null;
    refreshExpiresAt: string | null;
    updatedAt: string;
  } | null;
  /** The App's installations the connection reaches; null when unknown. */
  installations: Array<{
    login: string;
    type: "User" | "Organization";
    /** On their own account. */
    own: boolean;
    selection: "all" | "selected";
    suspended: boolean;
    manageUrl: string;
  }> | null;
  /** An old sign-in token kept for them. */
  legacy: { login: string | null; updatedAt: string | null } | null;
  mode: "store" | "fallback" | "off";
  result: string | null;
};

/** How the last connect ended (`?github=` from app/api/github/user/*). */
const RESULTS: Record<string, { tone: "info" | "warning" | "error"; text: string }> = {
  connected: { tone: "info", text: "GitHub is connected." },
  updated: { tone: "info", text: "Your repositories on GitHub are updated." },
  declined: { tone: "warning", text: "GitHub wasn't connected: it was cancelled on GitHub." },
  link_expired: { tone: "warning", text: "That GitHub link expired, or was opened in another browser. Try again from here." },
  other_account: {
    tone: "warning",
    text: "That's a different GitHub account from the one you sign in with. Connect that one (choose it on GitHub), or sign in with the other.",
  },
  not_configured: { tone: "error", text: "Connecting GitHub isn't set up on this deployment yet." },
  failed: { tone: "error", text: "GitHub didn't finish connecting. Try again." },
};

/** Where a user revokes an App's authorization themselves. */
const GITHUB_AUTHORIZED_APPS = "https://github.com/settings/apps/authorizations";

const BUTTON =
  "inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-sm text-foreground transition-colors hover:bg-input/50 disabled:opacity-60";
const PRIMARY = "inline-flex h-8 items-center gap-2 rounded-md bg-foreground px-3 text-sm font-medium text-background";

function day(iso: string | null): string | null {
  return iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null;
}

/**
 * Settings → Connections → GitHub: one card for the user's own GitHub
 * access. Connected as whom, which accounts' repositories it reaches (all or
 * selected, as picked on GitHub), whether it renews, and Connect, Manage
 * repositories, Reconnect and Disconnect, none of which signs them out.
 * `children` stands in where connecting is still the old sign-in link.
 */
export function GitHubConnectionCard({ view, children }: { view: GitHubCardView; children?: React.ReactNode }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"disconnect" | "legacy" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Disconnected here, but not revoked on GitHub: where to do that. */
  const [unrevoked, setUnrevoked] = useState<string | null>(null);
  const result = view.result && Object.hasOwn(RESULTS, view.result) ? RESULTS[view.result] : null;
  const connection = view.connection;
  const healthy = connection !== null && !connection.broken;
  const own = view.installations?.find((i) => i.own) ?? null;

  async function remove(what: "disconnect" | "legacy") {
    if (busy) return;
    setBusy(what);
    setError(null);
    setUnrevoked(null);
    try {
      const done = await requestJson<{ revoked?: boolean; revokeUrl?: string }>(
        what === "disconnect" ? "/api/github/user/connection" : "/api/github/user/legacy-token",
        { method: "DELETE" },
      );
      if (what === "disconnect" && done.revoked === false) setUnrevoked(done.revokeUrl ?? GITHUB_AUTHORIZED_APPS);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't do that. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (!view.configured) {
    return (
      <div className="space-y-3">
        <SectionHeader title="GitHub" />
        <p className="text-sm text-muted-foreground">
          {view.legacy
            ? `Sessions reach your repositories with the GitHub account you signed in with${view.legacy.login ? ` (@${view.legacy.login})` : ""}. If GitHub stops working, sign in with GitHub again to refresh it.`
            : "Sign in with GitHub to work on your repositories: sessions clone, push and open pull requests as your GitHub account."}
        </p>
        {children}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <SectionHeader title="GitHub" />
      <p className="text-sm text-muted-foreground">
        Your own repositories, through Outrunner&apos;s GitHub App: you pick on GitHub which ones it reaches, all of them
        or only those you select. Pushes and pull requests show as you. Signing in with GitHub doesn&apos;t give
        Outrunner your repositories.
      </p>

      {result && <InlineMessage tone={result.tone}>{result.text}</InlineMessage>}

      {view.legacy && !healthy && view.mode !== "store" && (
        <InlineMessage
          tone="warning"
          actions={[{ label: busy === "legacy" ? "Removing…" : "Remove old token", onClick: () => void remove("legacy"), disabled: busy !== null }]}
        >
          {view.mode === "off"
            ? "An old GitHub token from signing in is still kept for you, though it's no longer used. Remove it, and connect GitHub below."
            : `Your sessions still use an old GitHub token from signing in${view.legacy.login ? ` as @${view.legacy.login}` : ""}: it reaches every repository you can and never expires. Connect GitHub to choose which repositories Outrunner reaches; the old token is removed when you do.`}
        </InlineMessage>
      )}

      <div className="rounded-lg border border-border/60 p-3">
        {connection === null ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm text-foreground">
              <GitHubIcon className="size-4" /> Not connected
            </span>
            <GitHubConnectLink className={PRIMARY}>
              <GitHubIcon className="size-4" /> Connect GitHub
            </GitHubConnectLink>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm text-foreground">
                <GitHubIcon className="size-4" /> Connected as <span className="font-mono">@{connection.login}</span>
              </span>
              <Health connection={connection} />
            </div>

            {connection.broken ? (
              <InlineMessage tone="warning">
                GitHub stopped renewing Outrunner&apos;s access: it was revoked on GitHub, or went unused for six months.
                Reconnect to carry on; nothing else changes.
              </InlineMessage>
            ) : view.installations === null ? (
              <p className="text-xs text-muted-foreground">Couldn&apos;t ask GitHub which repositories it reaches just now.</p>
            ) : view.installations.length === 0 ? (
              <InlineMessage tone="warning">
                Outrunner&apos;s GitHub App isn&apos;t installed on any account you can reach, so it reaches none of your
                repositories yet. Install it and pick them.
              </InlineMessage>
            ) : (
              <ul className="divide-y divide-border/60 rounded-md border border-border/60">
                {view.installations.map((i) => (
                  <li key={i.manageUrl} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span>
                      <span className="font-mono">{i.login}</span>
                      <span className="text-muted-foreground">
                        {" · "}
                        {i.selection === "all" ? "All repositories" : "Selected repositories"}
                        {i.suspended && " · suspended"}
                      </span>
                    </span>
                    <a href={i.manageUrl} target="_blank" rel="noreferrer" className="text-xs text-foreground underline underline-offset-2">
                      {i.type === "User" || i.own ? "Manage repositories" : "Manage on GitHub"}
                    </a>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {healthy && (
                <>
                  {own ? (
                    <a href={own.manageUrl} target="_blank" rel="noreferrer" className={PRIMARY}>
                      Manage repositories
                    </a>
                  ) : (
                    <a href="/api/github/user/install" className={PRIMARY}>
                      Install on your account
                    </a>
                  )}
                  <a href="/api/github/user/install" className={BUTTON}>
                    Add an account
                  </a>
                </>
              )}
              <GitHubConnectLink className={connection.broken ? PRIMARY : BUTTON}>Reconnect</GitHubConnectLink>
              <button
                type="button"
                className={cn(BUTTON, "text-muted-foreground")}
                disabled={busy !== null}
                onClick={() => void remove("disconnect")}
              >
                {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          </div>
        )}
      </div>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {unrevoked && (
        <InlineMessage tone="warning" actions={[{ label: "Revoke on GitHub", href: unrevoked, external: true }]}>
          Disconnected here, but GitHub couldn&apos;t be asked to revoke Outrunner&apos;s access. Revoke it under your
          Authorized GitHub Apps to be sure.
        </InlineMessage>
      )}
      {children}
    </div>
  );
}

/** Whether the connection renews: its token health, in a few words. */
function Health({ connection }: { connection: NonNullable<GitHubCardView["connection"]> }) {
  if (connection.broken) return <span className="text-xs text-destructive">Needs reconnecting</span>;
  if (!connection.accessExpiresAt) {
    return <span className="text-xs text-muted-foreground">Access doesn&apos;t expire</span>;
  }
  const until = day(connection.refreshExpiresAt);
  return (
    <span
      className="text-xs text-muted-foreground"
      title={until ? `Each renewal keeps it going; left unused until ${until}, it would need reconnecting.` : undefined}
    >
      Renews automatically
    </span>
  );
}
