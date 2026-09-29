"use client";

import { Check, Loader2, Lock, RefreshCw, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Repo = {
  githubRepoId: number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  language: string | null;
  description: string | null;
  pushedAt: string | null;
};

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string; reconnect: boolean }
  | { phase: "ready"; repos: Repo[]; connected: Set<number> };

/**
 * Choose which GitHub repositories to work in.
 *
 * Browsing is separate from connecting: the list is read live from GitHub and
 * nothing is persisted until the user submits a selection. That keeps an
 * account with hundreds of repositories from turning all of them into projects
 * just by opening this page.
 *
 * Already-connected repositories are shown checked and disabled — connecting is
 * additive here, and removing one is a different action (it has workspaces and
 * history attached).
 */
export function RepoPicker() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch("/api/github/repositories");
        const data = (await res.json()) as {
          repositories?: Repo[];
          connected?: number[];
          error?: string;
        };
        if (!active) return;
        if (!res.ok) {
          setState({
            phase: "error",
            message: data.error ?? "Could not load repositories.",
            // 409 is the "no GitHub token" case, which a re-login fixes.
            reconnect: res.status === 409,
          });
          return;
        }
        setState({
          phase: "ready",
          repos: data.repositories ?? [],
          connected: new Set(data.connected ?? []),
        });
      } catch {
        if (active) {
          setState({ phase: "error", message: "Could not reach the server.", reconnect: false });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const visible = useMemo(() => {
    if (state.phase !== "ready") return [];
    const q = query.trim().toLowerCase();
    if (!q) return state.repos;
    return state.repos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q),
    );
  }, [state, query]);

  async function connect() {
    if (selected.size === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/projects/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoIds: [...selected] }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not connect those repositories.");
      router.push("/");
      router.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Something went wrong.");
      setSaving(false);
    }
  }

  if (state.phase === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading your repositories…
      </p>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{state.message}</p>
        {state.reconnect && (
          <p className="text-sm text-muted-foreground">
            Sign out and back in to grant repository access — the GitHub token comes from
            signing in.
          </p>
        )}
        <Button variant="secondary" onClick={() => router.refresh()}>
          <RefreshCw className="mr-1 size-4" /> Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${state.repos.length} repositories…`}
          aria-label="Search repositories"
        />
      </div>

      <ul className="max-h-[26rem] divide-y divide-border overflow-y-auto rounded-md border border-border">
        {visible.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-muted-foreground">
            No repositories match “{query}”.
          </li>
        )}
        {visible.map((repo) => {
          const already = state.connected.has(repo.githubRepoId);
          const checked = already || selected.has(repo.githubRepoId);
          return (
            <li key={repo.githubRepoId}>
              <label
                className={`flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-accent ${
                  already ? "cursor-default opacity-60 hover:bg-transparent" : ""
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0"
                  checked={checked}
                  disabled={already || saving}
                  onChange={(event) => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (event.target.checked) next.add(repo.githubRepoId);
                      else next.delete(repo.githubRepoId);
                      return next;
                    });
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <span className="truncate">{repo.fullName}</span>
                    {repo.private && (
                      <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Private" />
                    )}
                    {already && (
                      <span className="ml-1 flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <Check className="size-3" /> connected
                      </span>
                    )}
                  </span>
                  {repo.description && (
                    <span className="mt-0.5 block truncate text-sm text-muted-foreground">
                      {repo.description}
                    </span>
                  )}
                </span>
                {repo.language && (
                  <span className="shrink-0 text-xs text-muted-foreground">{repo.language}</span>
                )}
              </label>
            </li>
          );
        })}
      </ul>

      {saveError && <p className="text-sm text-destructive">{saveError}</p>}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {selected.size === 0
            ? "Select the repositories you want to work in."
            : `${selected.size} selected`}
        </p>
        <Button onClick={() => void connect()} disabled={selected.size === 0 || saving}>
          {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
          Connect{selected.size > 0 ? ` ${selected.size}` : ""}
        </Button>
      </div>
    </div>
  );
}
