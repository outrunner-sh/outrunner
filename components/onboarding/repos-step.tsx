"use client";

import { Check, Lock, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { GitHubConnectLink } from "@/components/github-connect-link";
import { GitHubReconnectLink } from "@/components/github-reconnect-link";
import { GitLabConnectionCard, type GitLabConnectionView } from "@/components/gitlab-connection-card";
import { repositoryKey, type CodeProvider } from "@/lib/code-providers/repository";
import { DashedPanel, DashedRule } from "@/components/onboarding/dashed";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/loaders";
import { LoadingButton } from "@/components/ui/loading-button";
import type { RepositoryListing } from "@/lib/github/listing";
import { OnboardingError } from "@/lib/onboarding/live-env";
import { connectedSummary, filterRepositories, pickedProjects, pickSummary, sortRepositories } from "@/lib/onboarding/rules";
import type { GitHubAccess, OnboardingEnv } from "@/lib/onboarding/types";
import type { Project } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

/**
 * Step 2, the last: GitHub or GitLab repositories to work on, connected as
 * projects. An org with some connected already says so in place of the
 * picker, which "Add more" opens: there, those show ticked and stay so, apart
 * from the new picks. Only the new picks are connected and counted, and the
 * first session starts on the first ticked. At least one repository is
 * needed, new or already connected: a session works in one. Done, onboarding
 * ends (`onDone`).
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
  /** The projects picked, to start a first session on; the button stays
   *  busy until it's done, as it leaves the page. */
  onDone: (projects: Project[]) => Promise<void>;
}) {
  const [provider, setProvider] = useState<CodeProvider>("github");
  const currentProvider = useRef<CodeProvider>("github");
  const [gitlab, setGitlab] = useState<GitLabConnectionView>();
  const [gitlabError, setGitlabError] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [list, setList] = useState<RepositoryListing[] | null>(null);
  // The new picks, in the order ticked; those already projects apart.
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [connected, setConnected] = useState<Set<number>>(new Set());
  // The picker opened ("Add more") where some are connected already.
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; reconnect: boolean } | null>(null);
  // The list itself not read: said in its place, with a retry, rather than
  // as an empty list with the error under it.
  const [listError, setListError] = useState<{ message: string; reconnect: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
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
        if (!stale && provider === "github" && active && noRepositories(found, active) && withApp) {
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
  }, [env, provider]);

  useEffect(() => {
    if (provider !== "gitlab") return;
    let stale = false;
    env.gitlabConnection().then((connection) => {
      if (!stale) { setGitlab(connection); setGitlabError(null); }
    }).catch((error: unknown) => {
      if (!stale) setGitlabError(error instanceof Error ? error.message : "Couldn't read your GitLab connection.");
    });
    return () => { stale = true; };
  }, [env, provider, connectionAttempt]);

  const active = access?.orgs.find((o) => o.id === access.activeOrgId);
  // Nothing to list from: no App in this org, and no GitHub sign-in.
  const unreachable = provider === "github" && !!access && !!active && noRepositories(access, active);
  const canList = provider === "gitlab" ? Boolean(gitlab) : access !== undefined && !unreachable;
  const githubOrgId = provider === "github" ? access?.activeOrgId : undefined;

  useEffect(() => {
    if (!canList) return;
    let stale = false;
    env
      .repositories(provider)
      .then(({ repositories, connected }) => {
        if (stale) return;
        setListError(null);
        setList(sortRepositories(repositories));
        setConnected(new Set(connected));
        setPicked(new Set());
      })
      .catch((e: unknown) => {
        if (stale) return;
        setList([]);
        setListError({
          message: e instanceof Error ? e.message : "Couldn't read your repositories.",
          reconnect: e instanceof OnboardingError && e.reconnect,
        });
      });
    return () => {
      stale = true;
    };
  }, [env, githubOrgId, canList, provider, attempt]);

  const retryList = () => {
    setList(null);
    setListError(null);
    setAttempt((n) => n + 1);
  };

  function changeProvider(next: CodeProvider) {
    if (provider === next) return;
    currentProvider.current = next;
    setProvider(next);
    setList(null);
    setPicked(new Set());
    setConnected(new Set());
    setBrowsing(false);
    setQuery("");
    setError(null);
    setListError(null);
    setGitlab(undefined);
    setGitlabError(null);
  }

  function changeGitlab(connection: GitLabConnectionView) {
    if (currentProvider.current !== "gitlab") return;
    setGitlab(connection);
    setPicked(new Set());
    setConnected(new Set());
    retryList();
  }

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
    setListError(null);
    setPicked(new Set());
    setConnected(new Set());
    setBrowsing(false);
    setAccess({ ...access, activeOrgId: orgId });
    setAttempt((n) => n + 1);
  }

  const shown = useMemo(() => filterRepositories(list ?? [], query), [list, query]);
  // Read, and some connected already: said so, rather than the list to pick from.
  const settled = list !== null && !listError && connected.size > 0 && !browsing;
  const summary = useMemo(
    () => connectedSummary(
      (list ?? []).flatMap((repo) => {
        const id = repo.repositoryId ?? repo.githubRepoId;
        return id !== null && connected.has(id) ? [repo.fullName] : [];
      }),
      connected.size,
    ),
    [list, connected],
  );
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
      // Nothing new: the new-session screen picks among those connected.
      const projects = ids.length > 0 ? await env.connect(ids, provider) : [];
      await onDone(pickedProjects(projects, ids, provider));
      // Still busy: the page is on its way out.
    } catch (e) {
      setError({
        message: e instanceof Error ? e.message : "Couldn't connect those repositories.",
        reconnect: e instanceof OnboardingError && e.reconnect,
      });
      setBusy(false);
    }
  }

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Pick your repositories</h1>
        <p className="text-muted-foreground text-sm">The ones you&apos;ll work on. Sessions clone them on their own cloud computer.</p>
      </div>

      <div role="group" aria-label="Code provider" className="flex gap-1 rounded-lg border border-border p-1">
        {(["github", "gitlab"] as const).map((id) => (
          <button key={id} type="button" aria-pressed={provider === id} disabled={busy} onClick={() => changeProvider(id)}
            className={cn("flex-1 rounded-md px-3 py-2 text-sm", provider === id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent")}>
            {id === "github" ? "GitHub" : "GitLab"}
          </button>
        ))}
      </div>

      {access && active && (
        <OrgSource access={access} active={active} provider={provider} onSwitch={(id) => void switchOrg(id)} />
      )}

      {provider === "gitlab" && (gitlabError ? (
        <p role="alert" className="text-sm text-destructive">{gitlabError} <button type="button" className="underline" onClick={() => setConnectionAttempt((n) => n + 1)}>Try again</button></p>
      ) : gitlab === undefined ? (
        <p className="text-sm text-muted-foreground">Checking your GitLab connection…</p>
      ) : (
        <GitLabConnectionCard initial={gitlab} saveConnection={env.saveGitlabConnection} onChange={changeGitlab} />
      ))}

      {unreachable && active ? (
        <ConnectGitHub
          ownHref={access.personalConnectable ? OWN_CONNECT_HREF : "/settings/account"}
          admin={active.admin}
          installable={access.appInstallable && (access.personalGithub || !access.installNeedsGithub)}
          linkFirst={access.appInstallable && !access.personalGithub && access.installNeedsGithub}
          ownRepositories={active.personal}
          orgName={active.name}
        />
      ) : settled ? (
        <DashedPanel className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm">
          <div className="min-w-0 space-y-0.5">
            <p className="text-foreground font-medium">{summary.title}</p>
            {summary.detail && <p className="text-muted-foreground truncate font-mono text-xs">{summary.detail}</p>}
          </div>
          <button type="button" disabled={busy} onClick={() => setBrowsing(true)} className="text-foreground shrink-0 underline underline-offset-4">
            Add more
          </button>
        </DashedPanel>
      ) : (provider === "github" || gitlab) && (
      <DashedPanel>
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search repositories"
            aria-label="Search repositories"
            className="h-12 rounded-none rounded-t-xl border-0 bg-transparent pl-11 text-sm shadow-none focus-visible:ring-2 focus-visible:ring-inset dark:bg-transparent"
          />
        </div>
        <DashedRule />
        <div className="max-h-[45vh] overflow-y-auto p-1.5">
          {list === null || (provider === "github" && access === undefined) ? (
            <div className="text-muted-foreground flex items-center gap-2 px-3 py-5 text-sm">
              <Spinner /> Reading your {provider === "gitlab" ? "GitLab" : "GitHub"} repositories…
            </div>
          ) : listError ? (
            <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-5 text-sm">
              <span className="text-destructive">
                {listError.message} {provider === "github" && listError.reconnect && <GitHubReconnectLink />}
              </span>
              <button type="button" onClick={retryList} className="text-foreground underline underline-offset-4">
                Try again
              </button>
            </div>
          ) : shown.length === 0 ? (
            <p className="text-muted-foreground px-3 py-5 text-sm">
              {query
                ? "No repository matches that."
                : provider === "gitlab" ? "No repositories on your GitLab account yet."
                : active?.accounts.length
                  ? `The GitHub App doesn't reach any repositories on ${active.accounts.join(", ")} yet.`
                  : "No repositories on your GitHub account yet."}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {shown.map((repo) => {
                const id = repo.repositoryId ?? repo.githubRepoId;
                const already = id !== null && connected.has(id);
                const on = already || (id !== null && picked.has(id));
                return (
                  <li key={repositoryKey(repo)}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      disabled={already}
                      onClick={() => id !== null && toggle(id)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                        already ? "cursor-default" : on ? "bg-accent/40" : "hover:bg-accent/20",
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                          already
                            ? "border-muted-foreground/60 bg-muted-foreground/60 text-background"
                            : on ? "border-foreground bg-foreground text-background" : "border-border",
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
                      {already && <span className="text-muted-foreground shrink-0 text-xs">Connected</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DashedPanel>
      )}

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error.message} {provider === "github" && error.reconnect && <GitHubReconnectLink />}
        </p>
      )}

      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">{settled ? "" : pickSummary(picked.size, connected.size)}</span>
        <LoadingButton
          size="default"
          status={busy ? "pending" : "idle"}
          disabled={picked.size === 0 && connected.size === 0}
          onClick={() => void next()}
          labels={{ idle: "Finish", pending: "Connecting" }}
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
  provider,
  onSwitch,
}: {
  access: GitHubAccess;
  active: GitHubAccess["orgs"][number];
  provider: CodeProvider;
  onSwitch: (orgId: string) => void;
}) {
  const from = provider === "gitlab" ? "from your GitLab account" : active.accounts.length
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
          className="border-border/60 bg-transparent text-foreground rounded-md border px-2 py-1 text-sm"
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
      {provider === "github" && active.personal && active.accounts.length === 0 && active.admin && access.appInstallable && access.personalGithub && (
        // A plain link: the install route goes to GitHub, then back here.
        <a href="/api/github/app/install?next=/onboarding" className="text-foreground underline underline-offset-4">
          Install the GitHub App instead
        </a>
      )}
    </div>
  );
}

/** Connecting the user's own GitHub for their repositories (Settings →
 *  Connections → GitHub), coming back here. */
const OWN_CONNECT_HREF = "/api/github/user/connect?next=/onboarding";

/** The way to their own GitHub: the connect flow (which works in the
 *  desktop shell too), or, where sign-in still keeps a token, Settings →
 *  Account's Connect GitHub. */
function OwnGitHubLink({ href, className, children }: { href: string; className: string; children: React.ReactNode }) {
  return href === OWN_CONNECT_HREF ? (
    <GitHubConnectLink next="/onboarding" className={className}>
      {children}
    </GitHubConnectLink>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

/** An org with no way to GitHub, for a user who hasn't connected their own:
 *  install the App (its admins; GitHub is asked who installed it on the way
 *  back), or connect their own GitHub for their own repositories (`ownHref`).
 *  Where GitHub can't be asked (`linkFirst`), installing takes the account
 *  linked first. */
function ConnectGitHub({
  ownHref,
  admin,
  installable,
  linkFirst,
  ownRepositories,
  orgName,
}: {
  ownHref: string;
  admin: boolean;
  installable: boolean;
  linkFirst: boolean;
  /** A personal org, which may list the user's own repositories instead. */
  ownRepositories: boolean;
  orgName: string;
}) {
  return (
    <DashedPanel className="space-y-3 px-5 py-5 text-sm">
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
              <OwnGitHubLink href={ownHref} className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline">
                Or connect your own GitHub account
              </OwnGitHubLink>
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
              <OwnGitHubLink href={ownHref} className="bg-foreground text-background rounded-md px-3 py-1.5 text-sm font-medium">
                Connect your GitHub account
              </OwnGitHubLink>
            )}
            <span className="text-muted-foreground">
              {ownRepositories ? "Or ask" : "Ask"} an admin of {orgName} to install the GitHub App.
            </span>
          </>
        )}
      </div>
    </DashedPanel>
  );
}

/** An org repositories can't come from: no App, and either a team's (which
 *  never lists a member's own) or a personal one with no GitHub sign-in. */
function noRepositories(access: GitHubAccess, org: GitHubAccess["orgs"][number]): boolean {
  return org.accounts.length === 0 && (!org.personal || !access.personalGithub);
}
