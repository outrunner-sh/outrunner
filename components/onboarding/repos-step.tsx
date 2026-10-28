"use client";

import { Check, Lock, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { GitHubReconnectLink } from "@/components/github-reconnect-link";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/loaders";
import { LoadingButton } from "@/components/ui/loading-button";
import type { RepositoryListing } from "@/lib/github/listing";
import { OnboardingError } from "@/lib/onboarding/live-env";
import { filterRepositories, sortRepositories } from "@/lib/onboarding/rules";
import type { GitHubAccess, OnboardingEnv } from "@/lib/onboarding/types";
import type { Project } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

/**
 * Step 2: the GitHub repositories to work on, connected as projects. Those
 * already connected start ticked. At least one is needed: a session works in
 * a repository.
 *
 * They're added to the active org, from its Outrunner GitHub App, or from the
 * user's own GitHub account in an org without it. One with neither (a Google
 * sign-in's personal org) gives way to an org of theirs with the App, and an
 * admin can install it from here, coming back after.
 */
export function ReposStep({
  env,
  onDone,
}: {
  env: OnboardingEnv;
  /** The projects picked, to start a first session on. */
  onDone: (projects: Project[]) => void;
}) {
  const [list, setList] = useState<RepositoryListing[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; reconnect: boolean } | null>(null);
  // undefined while read; null before orgs (the list alone, as it was).
  const [access, setAccess] = useState<GitHubAccess | null>();

  useEffect(() => {
    let stale = false;
    env
      .githubAccess()
      .catch(() => null)
      .then(async (found) => {
        // An org with no way to GitHub gives way to one with the App.
        if (!found) {
          if (!stale) setAccess(null);
          return;
        }
        const active = found.orgs.find((o) => o.id === found.activeOrgId);
        const withApp = found.orgs.find((o) => o.accounts.length > 0);
        if (!stale && active && noRepositories(found, active) && withApp) {
          // Kept if the switch fails: the Connect panel and the org switch.
          const switched = await env.useOrg(withApp.id).then(
            () => true,
            () => false,
          );
          if (!stale) setAccess(switched ? { ...found, activeOrgId: withApp.id } : found);
          return;
        }
        if (!stale) setAccess(found);
      })
      .catch(() => {
        if (!stale) setAccess(null);
      });
    return () => {
      stale = true;
    };
  }, [env]);

  const active = access?.orgs.find((o) => o.id === access.activeOrgId);
  // Nothing to list from: no App in this org, and no GitHub sign-in.
  const unreachable = !!access && !!active && noRepositories(access, active);

  useEffect(() => {
    if (access === undefined || unreachable) return;
    let stale = false;
    env
      .repositories()
      .then(({ repositories, connected }) => {
        if (stale) return;
        setList(sortRepositories(repositories));
        setPicked(new Set(connected));
      })
      .catch((e: unknown) => {
        if (stale) return;
        setList([]);
        setError({
          message: e instanceof Error ? e.message : "Couldn't read your repositories.",
          reconnect: e instanceof OnboardingError && e.reconnect,
        });
      });
    return () => {
      stale = true;
    };
  }, [env, access, unreachable]);

  async function switchOrg(orgId: string) {
    if (!access || orgId === access.activeOrgId) return;
    try {
      await env.useOrg(orgId);
    } catch {
      setError({ message: "Couldn't switch orgs. Try again.", reconnect: false });
      return;
    }
    setList(null);
    setError(null);
    setPicked(new Set());
    setAccess({ ...access, activeOrgId: orgId });
  }

  const shown = useMemo(() => filterRepositories(list ?? [], query), [list, query]);
  const toggle = (id: number) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function next() {
    setBusy(true);
    setError(null);
    try {
      const ids = [...picked];
      const projects = await env.connect(ids);
      onDone(projects.filter((project) => ids.includes(project.githubRepoId)));
    } catch (e) {
      setError({
        message: e instanceof Error ? e.message : "Couldn't connect those repositories.",
        reconnect: e instanceof OnboardingError && e.reconnect,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Pick your repositories</h1>
        <p className="text-muted-foreground text-sm">The ones you&apos;ll work on. Sessions clone them on their own cloud computer.</p>
      </div>

      {access && active && (
        <OrgSource access={access} active={active} onSwitch={(id) => void switchOrg(id)} />
      )}

      {unreachable && active ? (
        <ConnectGitHub
          admin={active.admin}
          installable={access.appInstallable && (access.personalGithub || !access.installNeedsGithub)}
          linkFirst={access.appInstallable && !access.personalGithub && access.installNeedsGithub}
          ownRepositories={active.personal}
          orgName={active.name}
        />
      ) : (
      <>
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search repositories" aria-label="Search repositories" className="pl-8 text-sm" />
      </div>

      <div className="border-border/60 max-h-[45vh] overflow-y-auto rounded-xl border">
        {list === null || access === undefined ? (
          <div className="text-muted-foreground flex items-center gap-2 px-4 py-6 text-sm">
            <Spinner /> Reading your GitHub repositories…
          </div>
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground px-4 py-6 text-sm">
            {query
              ? "No repository matches that."
              : active?.accounts.length
                ? `The GitHub App doesn't reach any repositories on ${active.accounts.join(", ")} yet.`
                : "No repositories on your GitHub account yet."}
          </p>
        ) : (
          <ul>
            {shown.map((repo) => {
              const on = picked.has(repo.githubRepoId);
              return (
                <li key={repo.githubRepoId} className="border-border/60 border-b last:border-b-0">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggle(repo.githubRepoId)}
                    className="hover:bg-accent/30 flex w-full items-center gap-3 px-4 py-3 text-left"
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded border",
                        on ? "border-foreground bg-foreground text-background" : "border-border",
                      )}
                    >
                      {on && <Check className="size-3" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground/90 flex items-center gap-1.5 font-mono text-[13px]">
                        <span className="truncate">{repo.fullName}</span>
                        {repo.private && <Lock className="text-muted-foreground size-3 shrink-0" aria-label="Private" />}
                      </span>
                      {repo.description && <span className="text-muted-foreground block truncate text-xs">{repo.description}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      </>
      )}

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error.message} {error.reconnect && <GitHubReconnectLink />}
        </p>
      )}

      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">{picked.size === 0 ? "Pick at least one" : `${picked.size} picked`}</span>
        <LoadingButton
          size="default"
          status={busy ? "pending" : "idle"}
          disabled={picked.size === 0}
          onClick={() => void next()}
          labels={{ idle: "Continue", pending: "Connecting" }}
        />
      </div>
    </section>
  );
}

/** Which org the repositories are added to, and where they come from; a
 *  switch when the user has more than one. */
function OrgSource({
  access,
  active,
  onSwitch,
}: {
  access: GitHubAccess;
  active: GitHubAccess["orgs"][number];
  onSwitch: (orgId: string) => void;
}) {
  const from = active.accounts.length
    ? `from the GitHub App on ${active.accounts.join(", ")}`
    : access.personalGithub
      ? "from your GitHub account"
      : "";
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm">
      <span>Adding to</span>
      {access.orgs.length > 1 ? (
        <select
          aria-label="Org"
          value={active.id}
          onChange={(e) => onSwitch(e.target.value)}
          className="border-border/60 bg-background text-foreground rounded-md border px-2 py-1 text-sm"
        >
          {access.orgs.map((org) => (
            <option key={org.id} value={org.id}>
              {org.personal ? "Personal" : org.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-foreground">{active.personal ? "Personal" : active.name}</span>
      )}
      {from && <span>{from}</span>}
      {active.personal && active.accounts.length === 0 && active.admin && access.appInstallable && access.personalGithub && (
        // A plain link: the install route goes to GitHub, then back here.
        <a href="/api/github/app/install?next=/onboarding" className="text-foreground underline underline-offset-4">
          Install the GitHub App instead
        </a>
      )}
    </div>
  );
}

/** An org with no way to GitHub, for a user with no GitHub account linked:
 *  install the App (its admins; GitHub is asked who installed it on the way
 *  back), or link a GitHub account for their own repositories. Where GitHub
 *  can't be asked (`linkFirst`), installing takes the account linked first. */
function ConnectGitHub({
  admin,
  installable,
  linkFirst,
  ownRepositories,
  orgName,
}: {
  admin: boolean;
  installable: boolean;
  linkFirst: boolean;
  /** A personal org, which may list the user's own repositories instead. */
  ownRepositories: boolean;
  orgName: string;
}) {
  return (
    <div className="border-border/60 space-y-3 rounded-xl border px-4 py-5 text-sm">
      <p className="text-foreground font-medium">Connect GitHub</p>
      <p className="text-muted-foreground">
        Install the Outrunner GitHub App on your GitHub account or organization and pick the repositories it can reach.
        Sessions clone, push and open pull requests through it.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        {admin && installable ? (
          <>
            {/* A plain link: the install route goes to GitHub, then back here. */}
            <a
              href="/api/github/app/install?next=/onboarding"
              className="bg-foreground text-background rounded-md px-3 py-1.5 text-sm font-medium"
            >
              Install GitHub App
            </a>
            {ownRepositories && (
              <Link href="/settings/account" className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline">
                Or use your own GitHub account
              </Link>
            )}
          </>
        ) : admin && linkFirst ? (
          <>
            <Link href="/settings/account" className="bg-foreground text-background rounded-md px-3 py-1.5 text-sm font-medium">
              Link your GitHub account
            </Link>
            <span className="text-muted-foreground">
              {ownRepositories
                ? "Then come back here to install the App, or pick from your own repositories."
                : "Then come back here to install the App."}
            </span>
          </>
        ) : (
          <>
            {ownRepositories && (
              <Link href="/settings/account" className="bg-foreground text-background rounded-md px-3 py-1.5 text-sm font-medium">
                Link your GitHub account
              </Link>
            )}
            <span className="text-muted-foreground">
              {ownRepositories ? "Or ask" : "Ask"} an admin of {orgName} to install the GitHub App.
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/** An org repositories can't come from: no App, and either a team's (which
 *  never lists a member's own) or a personal one with no GitHub sign-in. */
function noRepositories(access: GitHubAccess, org: GitHubAccess["orgs"][number]): boolean {
  return org.accounts.length === 0 && (!org.personal || !access.personalGithub);
}
