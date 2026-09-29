"use client";

import { ChevronDown, Loader2, Lock, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ProjectAvatar } from "@/components/project-avatar";
import type { Project } from "@/lib/runtime/types";

type Repo = {
  githubRepoId: number;
  fullName: string;
  name: string;
  private: boolean;
};

type Listing = { repositories: Repo[]; connected: number[] };

/**
 * Pick the repository a session runs in — from everything on the user's GitHub,
 * not only what they connected earlier.
 *
 * Connecting is implicit: choosing a repository that has no project row creates
 * one, then selects it. Making "connect" a separate step people had to find
 * first meant the list only ever showed what you had already added, which is
 * backwards from how you actually reach for a repo.
 *
 * The listing is fetched lazily on first open — it is a live GitHub call, and
 * paying for it on every page load would slow the composer down for the common
 * case of reusing the current project.
 */
export function RepositorySelect({
  projects,
  selectedProjectId,
  onSelect,
  disabled,
}: {
  /** Already-connected projects; used before the live list has loaded. */
  projects: Project[];
  selectedProjectId: string | null;
  /** Receives the project id to run in, connecting the repository if needed. */
  onSelect: (projectId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [connectingId, setConnectingId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = projects.find((p) => p.id === selectedProjectId);

  async function load(force = false) {
    if (loading || (listing && !force)) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/github/repositories", {
        cache: force ? "no-store" : "default",
      });
      const data = (await res.json()) as Partial<Listing> & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not load repositories.");
      setListing({ repositories: data.repositories ?? [], connected: data.connected ?? [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load repositories.");
    } finally {
      setLoading(false);
    }
  }

  // Focus search on open so typing filters immediately. The fetch is kicked off
  // from the trigger's click handler rather than here — starting it in an effect
  // sets state during render and cascades.
  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  // Close on outside click / Escape.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visible = useMemo(() => {
    const repos =
      listing?.repositories ??
      // Before the live list arrives, offer what is already connected so the
      // menu is never empty.
      projects.map((p) => ({
        githubRepoId: p.githubRepoId,
        fullName: p.fullName,
        name: p.name,
        private: false,
      }));
    const q = query.trim().toLowerCase();
    return q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : repos;
  }, [listing, projects, query]);

  async function choose(repo: Repo) {
    const existing = projects.find((p) => p.githubRepoId === repo.githubRepoId);
    if (existing) {
      onSelect(existing.id);
      setOpen(false);
      return;
    }
    // Not connected yet — connect just this one, then select it.
    setConnectingId(repo.githubRepoId);
    setError(null);
    try {
      const res = await fetch("/api/projects/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoIds: [repo.githubRepoId] }),
      });
      const data = (await res.json()) as { projects?: Project[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not connect that repository.");
      const created = data.projects?.find((p) => p.githubRepoId === repo.githubRepoId);
      if (!created) throw new Error("Connected, but the project did not come back.");
      onSelect(created.id);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect that repository.");
    } finally {
      setConnectingId(null);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
        }}
        className="text-foreground hover:bg-accent flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors disabled:opacity-50"
      >
        <ProjectAvatar name={selected?.name ?? "?"} className="size-5" />
        {selected?.name ?? "Select repository…"}
        <ChevronDown className="text-muted-foreground size-4" />
      </button>

      {open && (
        <div className="bg-popover border-border absolute bottom-full left-1/2 z-50 mb-2 w-80 -translate-x-1/2 overflow-hidden rounded-lg border shadow-xl">
          <div className="max-h-72 overflow-y-auto py-1">
            {loading && !listing && (
              <p className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-sm">
                <Loader2 className="size-4 animate-spin" /> Loading repositories…
              </p>
            )}
            {!loading && visible.length === 0 && (
              <p className="text-muted-foreground px-3 py-2 text-sm">
                {query ? `No repositories match “${query}”.` : "No repositories found."}
              </p>
            )}
            {visible.map((repo) => (
              <button
                key={repo.githubRepoId}
                type="button"
                disabled={connectingId !== null}
                onClick={() => void choose(repo)}
                className="hover:bg-accent flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm disabled:opacity-50"
              >
                <span className="flex-1 truncate">{repo.fullName}</span>
                {repo.private && <Lock className="text-muted-foreground size-3 shrink-0" />}
                {connectingId === repo.githubRepoId && (
                  <Loader2 className="size-3 shrink-0 animate-spin" />
                )}
              </button>
            ))}
          </div>

          <div className="border-border border-t">
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading}
              className="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left text-sm disabled:opacity-50"
            >
              <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Refresh list
            </button>
          </div>

          {error && (
            <p className="text-destructive border-border border-t px-3 py-2 text-xs">{error}</p>
          )}

          <div className="border-border relative border-t">
            <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search repositories…"
              aria-label="Search repositories"
              className="placeholder:text-muted-foreground w-full bg-transparent py-2.5 pl-9 pr-3 text-sm outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}
