"use client";

import { Check, Lock, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppSourceNote, PickerErrorMessage } from "@/components/repository-source-note";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/loaders";
import { LoadingButton } from "@/components/ui/loading-button";
import { useSharedResource } from "@/hooks/use-shared-resource";
import { ConnectError, connectRepositories, type PickerError, refreshListing, repositoryListing } from "@/lib/client/repository-listing";
import { repositoryKey, type CodeProvider } from "@/lib/code-providers/repository";
import type { RepositoryListing } from "@/lib/github/listing";
import { filterRepositories, pickedProjects, sortRepositories } from "@/lib/onboarding/rules";
import type { Project } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

/** A repository's id on its provider: what connecting it takes. */
function repoId(repo: RepositoryListing): number | null {
  return repo.repositoryId ?? repo.githubRepoId;
}

/**
 * The one repository picker: in setup, an environment's Repositories
 * section, and Environments after GitHub is connected. It lists everything
 * the org's GitHub App reaches (or the user's own GitHub, or GitLab), the
 * connected ones marked, and those already in the environment ticked for
 * good. Ticking some and pressing the button connects them (or refreshes
 * them, connected already) to the org — never every repository there — and
 * hands their projects, in the order ticked, to `onPicked`, which adds them
 * to the environment. Its failure is said here, the picks kept.
 */
export function RepositoryPicker({
  inEnvironment = [],
  max,
  submitLabel,
  submitBlocked = false,
  onPicked,
  onCancel,
  className,
}: {
  /** Full names of the repositories in the environment already: shown
   *  ticked, not picked again. */
  inEnvironment?: readonly string[];
  /** How many may be picked: the room the environment has left. */
  max?: number;
  submitLabel: string;
  /** Something else the button waits for first (a name for a new
   *  environment): nothing is connected until it's given. */
  submitBlocked?: boolean;
  /** Given the connected projects of the picks, in the order ticked: adds
   *  them where they go. A throw is shown here, its message the reason. */
  onPicked: (projects: Project[]) => Promise<void>;
  onCancel?: () => void;
  className?: string;
}) {
  const [provider, setProvider] = useState<CodeProvider>("github");
  const resource = repositoryListing(provider);
  const answer = useSharedResource(resource);
  const listing = answer.value?.listing ?? null;
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  // Ids on the provider, in the order ticked.
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PickerError | null>(null);
  const listError = answer.value?.error ?? null;

  // Looked up as it mounts: a listing from the last few seconds shows at once.
  useEffect(() => {
    void resource.refresh();
  }, [resource]);

  const already = useMemo(() => new Set(inEnvironment.map((name) => name.toLowerCase())), [inEnvironment]);
  const connected = useMemo(() => new Set(listing?.connected ?? []), [listing]);
  const shown = useMemo(() => filterRepositories(sortRepositories(listing?.repositories ?? []), query), [listing, query]);
  const full = max !== undefined && picked.length >= max;

  function changeProvider(next: CodeProvider) {
    if (next === provider) return;
    setProvider(next);
    setPicked([]);
    setQuery("");
    setError(null);
  }

  function toggle(id: number) {
    setPicked((current) => (current.includes(id) ? current.filter((p) => p !== id) : full ? current : [...current, id]));
  }

  async function refresh() {
    setRefreshing(true);
    await refreshListing(provider);
    setRefreshing(false);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const projects = await connectRepositories(picked, provider);
      const ordered = pickedProjects(projects, picked, provider);
      if (ordered.length < picked.length) {
        throw new Error("Connected them, but Outrunner couldn't find them all afterwards. Refresh the list and try again.");
      }
      await onPicked(ordered);
      setPicked([]);
    } catch (cause) {
      setError(
        cause instanceof ConnectError
          ? { message: cause.message, reconnect: cause.reconnect, noAccess: cause.noAccess }
          : { message: cause instanceof Error ? cause.message : "Couldn't add those repositories. Try again.", reconnect: false },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div className="overflow-hidden rounded-lg border border-border/60">
        <div className="flex gap-1 border-b border-border/60 p-1" role="group" aria-label="Code provider">
          {(["github", "gitlab"] as const).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={provider === id}
              disabled={busy}
              onClick={() => changeProvider(id)}
              className={cn("flex-1 rounded-md px-3 py-1.5 text-sm", provider === id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent")}
            >
              {id === "github" ? "GitHub" : "GitLab"}
            </button>
          ))}
        </div>
        <div className="relative border-b border-border/60">
          <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search repositories"
            aria-label="Search repositories"
            className="placeholder:text-muted-foreground w-full bg-transparent py-2.5 pl-9 pr-3 text-base outline-none sm:text-sm"
          />
        </div>
        <div className="max-h-[45vh] overflow-y-auto p-1">
          {answer.status === "loading" && !listing ? (
            <p className="text-muted-foreground flex items-center gap-2 px-3 py-4 text-sm">
              <Spinner className="size-4" /> Reading your {provider === "gitlab" ? "GitLab" : "GitHub"} repositories…
            </p>
          ) : listError && !listing ? (
            <div role="alert" className="space-y-2 px-3 py-4">
              <PickerErrorMessage error={listError} listing={null} provider={provider} />
              <button type="button" onClick={() => void refresh()} className="text-foreground text-sm underline underline-offset-4">
                Try again
              </button>
            </div>
          ) : shown.length === 0 ? (
            <p className="text-muted-foreground px-3 py-4 text-sm">
              {query
                ? "No repository matches that."
                : listing?.source.kind === "app"
                  ? `Outrunner's GitHub App doesn't reach any repositories on ${listing.source.accounts.map((a) => a.login).join(", ")} yet.`
                  : "No repositories found."}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {shown.map((repo) => {
                const id = repoId(repo);
                const fixed = already.has(repo.fullName.toLowerCase());
                const on = fixed || (id !== null && picked.includes(id));
                const isConnected = id !== null && connected.has(id);
                return (
                  <li key={repositoryKey(repo)}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      disabled={fixed || busy || id === null || (!on && full)}
                      onClick={() => id !== null && toggle(id)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors disabled:cursor-default",
                        on && !fixed ? "bg-accent/50" : "enabled:hover:bg-accent/30",
                        !on && full && "opacity-50",
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded border",
                          fixed
                            ? "border-muted-foreground/60 bg-muted-foreground/60 text-background"
                            : on ? "border-foreground bg-foreground text-background" : "border-border",
                        )}
                      >
                        {on && <Check className="size-3" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground flex items-center gap-1.5 font-mono text-[13px]">
                          <span className="truncate">{repo.fullName}</span>
                          {repo.private && <Lock className="text-muted-foreground size-3 shrink-0" aria-label="Private" />}
                        </span>
                        {repo.description && <span className="text-muted-foreground block truncate text-xs">{repo.description}</span>}
                      </span>
                      {(fixed || isConnected) && (
                        <span className="text-muted-foreground shrink-0 text-xs">{fixed ? "In this environment" : "Connected"}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {listing && (listing.ssoPartialOrgIds.length > 0 || !listing.complete) && (
          <p className="text-muted-foreground border-t border-border/60 px-3 py-2 text-xs">
            {listing.ssoPartialOrgIds.length > 0
              ? "Some organizations' repositories are hidden until you authorize Outrunner for their single sign-on on GitHub."
              : `${provider === "gitlab" ? "GitLab" : "GitHub"} may have more repositories than this list shows.`}
          </p>
        )}
        {listing?.source.kind === "app" && (
          <AppSourceNote accounts={listing.source.accounts} className="text-muted-foreground border-t border-border/60 px-3 py-2 text-xs" />
        )}
      </div>

      {error && <PickerErrorMessage error={error} listing={listing} provider={provider} />}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          {picked.length === 0 ? "Pick at least one" : `${picked.length} picked`}
          {max !== undefined && ` · up to ${max}`}
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" disabled={refreshing || busy} onClick={() => void refresh()}>
            {refreshing ? <Spinner className="size-4" /> : <RefreshCw />} Refresh list
          </Button>
          {onCancel && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          )}
          <LoadingButton
            status={busy ? "pending" : "idle"}
            disabled={picked.length === 0 || submitBlocked}
            labels={{ idle: submitLabel }}
            onClick={() => void submit()}
          />
        </div>
      </div>
    </div>
  );
}
