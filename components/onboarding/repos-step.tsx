"use client";

import { Check, Lock, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { GitHubReconnectLink } from "@/components/github-reconnect-link";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/loaders";
import { LoadingButton } from "@/components/ui/loading-button";
import type { RepositoryListing } from "@/lib/github/listing";
import { OnboardingError } from "@/lib/onboarding/live-env";
import { filterRepositories, sortRepositories } from "@/lib/onboarding/rules";
import type { OnboardingEnv } from "@/lib/onboarding/types";
import type { Project } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

/**
 * Step 2: the GitHub repositories to work on, connected as projects. Those
 * already connected start ticked. At least one is needed: a session works in
 * a repository.
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

  useEffect(() => {
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
  }, [env]);

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

      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search repositories" aria-label="Search repositories" className="pl-8 text-sm" />
      </div>

      <div className="border-border/60 max-h-[45vh] overflow-y-auto rounded-xl border">
        {list === null ? (
          <div className="text-muted-foreground flex items-center gap-2 px-4 py-6 text-sm">
            <Spinner /> Reading your GitHub repositories…
          </div>
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground px-4 py-6 text-sm">
            {query ? "No repository matches that." : "No repositories on your GitHub account yet."}
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
