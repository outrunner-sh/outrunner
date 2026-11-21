"use client";

import { Check } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { GitLabConnectionCard, type GitLabConnectionView } from "@/components/gitlab-connection-card";
import { DashedPanel } from "@/components/onboarding/dashed";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import type { GitHubAccess, OnboardingEnv } from "@/lib/onboarding/types";

/** Installing the App: GitHub, then back here. A plain link, not a fetch. */
const INSTALL_HREF = "/api/github/app/install?next=/onboarding";

/**
 * Step 2: where the org's repositories come from. The Outrunner GitHub App,
 * installed on its GitHub accounts (or one installed there already, added
 * to this org with a click, as Settings → Org → GitHub offers); GitLab
 * instead, by its token. Done once one of those answers; the next step picks
 * the repositories.
 */
export function GitHubStep({ env, onDone }: { env: OnboardingEnv; onDone: () => void }) {
  // undefined while read; null when it couldn't be.
  const [access, setAccess] = useState<GitHubAccess | null>();
  const [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gitlabOpen, setGitlabOpen] = useState(false);
  // undefined until read, as the card wants it.
  const [gitlab, setGitlab] = useState<GitLabConnectionView>();

  useEffect(() => {
    let stale = false;
    env.githubAccess().then(
      (found) => !stale && setAccess(found),
      () => !stale && setAccess(null),
    );
    return () => {
      stale = true;
    };
  }, [env, attempt]);

  useEffect(() => {
    if (!gitlabOpen || gitlab !== undefined) return;
    let stale = false;
    env.gitlabConnection().then(
      (connection) => !stale && setGitlab(connection),
      () => !stale && setGitlab(null),
    );
    return () => {
      stale = true;
    };
  }, [env, gitlabOpen, gitlab]);

  async function add(installationId: number) {
    setAdding(installationId);
    setError(null);
    try {
      await env.addInstallation(installationId);
      setAttempt((n) => n + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't add it. Try again.");
    } finally {
      setAdding(null);
    }
  }

  const connected = Boolean(access && access.accounts.length > 0);
  const ready = connected || Boolean(gitlab);

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Connect GitHub</h1>
        <p className="text-muted-foreground text-sm">
          Where {env.org.name}&apos;s repositories come from. Sessions clone, push and open pull requests
          through it.
        </p>
      </div>

      {access === undefined ? (
        <p className="text-muted-foreground text-sm">Checking GitHub…</p>
      ) : access === null ? (
        <p role="alert" className="text-sm">
          <span className="text-destructive">Couldn&apos;t check GitHub.</span>{" "}
          <button type="button" className="underline underline-offset-4" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </p>
      ) : connected ? (
        <DashedPanel className="flex items-start gap-3 px-5 py-4 text-sm">
          <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-hidden />
          <div className="min-w-0 space-y-0.5">
            <p className="text-foreground font-medium">GitHub is connected</p>
            <p className="text-muted-foreground">
              Outrunner&apos;s GitHub App on {access.accounts.join(", ")}.
            </p>
            {access.admin && access.appInstallable && (
              <a href={INSTALL_HREF} className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-4">
                Install it on another account
              </a>
            )}
          </div>
        </DashedPanel>
      ) : (
        <ConnectGitHub env={env} access={access} adding={adding} onAdd={(id) => void add(id)} />
      )}

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {gitlabOpen ? (
        gitlab === undefined ? (
          <p className="text-muted-foreground text-sm">Checking your GitLab connection…</p>
        ) : (
          <GitLabConnectionCard initial={gitlab} saveConnection={env.saveGitlabConnection} onChange={setGitlab} />
        )
      ) : (
        !connected && (
          <button type="button" onClick={() => setGitlabOpen(true)} className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4">
            Use GitLab instead
          </button>
        )
      )}

      <div className="flex justify-end">
        <LoadingButton size="default" status="idle" disabled={!ready} onClick={onDone} labels={{ idle: "Continue" }} />
      </div>
    </section>
  );
}

/** The org has no way to GitHub yet: install the App (its admins), or add
 *  an installation already on GitHub. Where GitHub can't be asked who
 *  installed it (`installNeedsGithub`), installing takes the account linked
 *  first. */
function ConnectGitHub({
  env,
  access,
  adding,
  onAdd,
}: {
  env: OnboardingEnv;
  access: GitHubAccess;
  adding: number | null;
  onAdd: (installationId: number) => void;
}) {
  const linkFirst = access.appInstallable && !access.personalGithub && access.installNeedsGithub;
  return (
    <DashedPanel className="space-y-4 px-5 py-5 text-sm">
      {access.available.length > 0 && (
        <ul className="space-y-2">
          {access.available.map((installation) => (
            <li key={installation.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                Outrunner&apos;s GitHub App is installed on <span className="font-medium">{installation.accountLogin}</span>.
              </span>
              <LoadingButton
                status={adding === installation.id ? "pending" : "idle"}
                disabled={adding !== null && adding !== installation.id}
                onClick={() => onAdd(installation.id)}
                labels={{ idle: `Add to ${env.org.name}` }}
              />
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground">
        Install the Outrunner GitHub App on your GitHub account or organization, and choose the repositories it can reach.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        {access.admin && access.appInstallable && !linkFirst ? (
          <Button asChild size="sm">
            {/* A plain link: the install route goes to GitHub, then back here. */}
            <a href={INSTALL_HREF}>Install GitHub App</a>
          </Button>
        ) : access.admin && linkFirst ? (
          <>
            <Button asChild size="sm">
              <Link href="/settings/account">Link your GitHub account</Link>
            </Button>
            <span className="text-muted-foreground">Then come back here to install the App.</span>
          </>
        ) : (
          !access.admin && <span className="text-muted-foreground">Ask an admin of {env.org.name} to install the GitHub App.</span>
        )}
      </div>
    </DashedPanel>
  );
}
