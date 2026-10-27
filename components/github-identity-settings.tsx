"use client";

import { Check } from "lucide-react";
import { useState } from "react";

import { GitHubIcon } from "@/components/brand-icons";
import { SectionHeader } from "@/components/settings-details";
import { InlineMessage } from "@/components/ui/notice";
import type { GitHubIdentity } from "@/lib/db/credentials";
import { requestJson } from "@/lib/http/request-json";
import { cn } from "@/lib/utils";

/** The org being looked at, and where Outrunner's GitHub App is installed in
 *  it: what working as the App reaches there. */
export type IdentityOrgView = { name: string; installedOn: string[]; admin: boolean };

/**
 * Settings → Account → GitHub identity: who the user's sessions clone, push
 * and open pull requests as (lib/github/identity.ts). Their own GitHub
 * account, as every session had before, or the Outrunner GitHub App of each
 * session's org. Says what the App reaches in the org they're looking at.
 */
export function GitHubIdentitySettings({
  initial,
  login,
  appConfigured,
  org,
}: {
  initial: GitHubIdentity;
  login: string;
  /** Whether this deployment has the App set up at all. */
  appConfigured: boolean;
  org: IdentityOrgView | null;
}) {
  const [identity, setIdentity] = useState(initial);
  const [saving, setSaving] = useState<GitHubIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(next: GitHubIdentity) {
    if (next === identity || saving) return;
    setSaving(next);
    setError(null);
    try {
      const data = await requestJson<{ identity: GitHubIdentity }>("/api/settings/github-identity", {
        method: "PUT",
        body: { identity: next },
        has: (d) => d.identity !== undefined,
      });
      setIdentity(data.identity);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setSaving(null);
    }
  }

  const options: Array<{ id: GitHubIdentity; label: string; detail: string; disabled?: boolean }> = [
    {
      id: "personal",
      label: "My GitHub account",
      detail: `Pushes and pull requests show as you${login ? ` (@${login})` : ""}, with what your account can reach.`,
    },
    {
      id: "app",
      label: "Outrunner App",
      detail:
        "Pushes and pull requests show as Outrunner's GitHub App, installed on each org's repositories; your commits keep you as their author.",
      disabled: !appConfigured,
    },
  ];

  return (
    <div className="space-y-3">
      <SectionHeader title="GitHub identity" />
      <p className="text-sm text-muted-foreground">
        Who your sessions clone, push and open pull requests as. Sessions already running switch within the hour.
      </p>
      <div role="radiogroup" aria-label="GitHub identity" className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const chosen = option.id === identity;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={chosen}
              disabled={option.disabled || saving !== null}
              onClick={() => void choose(option.id)}
              className={cn(
                "relative flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                chosen
                  ? "border-foreground/40 bg-muted/50"
                  : "border-border/60 hover:bg-muted/30",
              )}
            >
              <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                <GitHubIcon className="size-3.5" />
                {option.label}
              </span>
              <span className="text-xs text-muted-foreground">{option.detail}</span>
              {chosen && <Check aria-hidden className="absolute top-3 right-3 size-3.5 text-foreground" />}
            </button>
          );
        })}
      </div>
      {identity === "app" && org && <AppReach org={org} />}
      {!appConfigured && (
        <p className="text-xs text-muted-foreground">Outrunner&apos;s GitHub App isn&apos;t set up on this server.</p>
      )}
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
    </div>
  );
}

/** What the App reaches in the org being looked at, and where to change it. */
function AppReach({ org }: { org: IdentityOrgView }) {
  if (org.installedOn.length > 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {`In ${org.name}, the App is installed on ${org.installedOn.join(", ")}. Repositories elsewhere won't clone or push until it's installed there too.`}
      </p>
    );
  }
  return (
    <InlineMessage
      tone="warning"
      actions={org.admin ? [{ label: "Install the GitHub App", href: "/settings/org/github" }] : undefined}
    >
      {org.admin
        ? `${org.name} hasn't installed the App yet, so its sessions can't reach GitHub as it.`
        : `${org.name} hasn't installed the App yet, so its sessions can't reach GitHub as it. Ask an admin to install it, or choose your own account.`}
    </InlineMessage>
  );
}
