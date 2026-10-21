"use client";

import { ChevronDown, Lock, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { GitHubReconnectLink } from "@/components/github-reconnect-link";
import { ProjectAvatar } from "@/components/project-avatar";
import { Spinner } from "@/components/ui/loaders";
import { useCloseWhenHidden } from "@/hooks/use-close-when-hidden";
import { projectToListing, type RepositoryListing } from "@/lib/github/listing";
import type { Project } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

type Listing = {
  repositories: RepositoryListing[];
  connected: number[];
  /** False when GitHub may have more than the list holds. */
  complete: boolean;
  /** Organizations whose repositories single sign-on held back. */
  ssoPartialOrgIds: number[];
};

/** A failed request's message, and whether only reconnecting GitHub fixes it. */
type PickerError = { message: string; reconnect: boolean };

/** Read the API's error body (`reconnect` set when the token is the problem). */
async function readError(res: Response, fallback: string): Promise<PickerError> {
  const data = (await res.json().catch(() => ({}))) as { error?: string; reconnect?: boolean };
  return { message: data.error ?? fallback, reconnect: data.reconnect === true };
}

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
  projects = [],
  selectedProjectId = null,
  onSelect,
  onPick,
  label,
  extra,
  disabled,
  triggerClassName,
}: {
  /** Already-connected projects; used before the live list has loaded. */
  projects?: Project[];
  selectedProjectId?: string | null;
  /** Receives the project to run in, connecting the repository if needed: a
   *  just-connected one is not in `projects` yet. */
  onSelect?: (project: Project) => void;
  /** Instead of connecting it as a project, what picking a repository does
   *  (a session on this Mac clones it). The menu closes as it starts. */
  onPick?: (repo: RepositoryListing) => void;
  /** What the trigger shows in place of the selected project. */
  label?: { text: string; title?: string; icon: React.ReactNode };
  /** One more row under the list, such as choosing a folder instead. */
  extra?: { label: string; icon: React.ReactNode; onClick: () => void };
  disabled?: boolean;
  /** Replaces the trigger's default look, to sit in a row of other pickers. */
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  useCloseWhenHidden(useCallback(() => setOpen(false), []));
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PickerError | null>(null);
  const [query, setQuery] = useState("");
  const [connectingId, setConnectingId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The option the arrow keys are on (a combobox: focus stays in the search
  // field, and this one is announced as active).
  const [active, setActive] = useState(0);
  const listId = useId();

  const selected = projects.find((p) => p.id === selectedProjectId);

  async function load(force = false) {
    if (loading || (listing && !force)) return;
    setLoading(true);
    setError(null);
    try {
      // Refresh asks GitHub again; otherwise a listing from the last few
      // seconds is fine (app/api/github/repositories).
      const res = await fetch(force ? "/api/github/repositories?fresh=1" : "/api/github/repositories");
      if (!res.ok) {
        setError(await readError(res, "Could not load repositories."));
        return;
      }
      const data = (await res.json()) as Partial<Listing>;
      setListing({
        repositories: data.repositories ?? [],
        connected: data.connected ?? [],
        complete: data.complete ?? true,
        ssoPartialOrgIds: data.ssoPartialOrgIds ?? [],
      });
    } catch {
      setError({ message: "Could not load repositories.", reconnect: false });
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
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
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
      projects.map(projectToListing);
    const q = query.trim().toLowerCase();
    return q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : repos;
  }, [listing, projects, query]);

  async function choose(repo: RepositoryListing) {
    if (onPick) {
      setOpen(false);
      triggerRef.current?.focus();
      onPick(repo);
      return;
    }
    const existing = projects.find((p) => p.githubRepoId === repo.githubRepoId);
    if (existing) {
      onSelect?.(existing);
      setOpen(false);
      triggerRef.current?.focus();
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
      if (!res.ok) {
        setError(await readError(res, "Could not connect that repository."));
        return;
      }
      const data = (await res.json()) as { projects?: Project[] };
      const created = data.projects?.find((p) => p.githubRepoId === repo.githubRepoId);
      if (!created) {
        setError({ message: "Connected, but the project did not come back.", reconnect: false });
        return;
      }
      onSelect?.(created);
      setOpen(false);
      triggerRef.current?.focus();
    } catch {
      setError({ message: "Could not connect that repository.", reconnect: false });
    } finally {
      setConnectingId(null);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          setActive(0);
          if (next) void load();
        }}
        className={
          triggerClassName ??
          "text-foreground hover:bg-accent flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors disabled:opacity-50"
        }
      >
        {label ? (
          <>
            {label.icon}
            <span className="truncate" title={label.title}>
              {label.text}
            </span>
          </>
        ) : (
          <>
            <ProjectAvatar name={selected?.name ?? "?"} className="size-5" />
            {selected?.name ?? "Select repository…"}
          </>
        )}
        <ChevronDown className="text-muted-foreground size-4" />
      </button>

      {open && (
        <div className="bg-popover border-border absolute bottom-full left-1/2 z-50 mb-2 w-80 -translate-x-1/2 overflow-hidden rounded-lg border shadow-xl">
          <div id={listId} role="listbox" aria-label="Repositories" className="max-h-72 overflow-y-auto py-1">
            {loading && !listing && (
              <p className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-sm">
                <Spinner className="size-4" /> Loading repositories…
              </p>
            )}
            {!loading && visible.length === 0 && (
              <p className="text-muted-foreground px-3 py-2 text-sm">
                {query ? `No repositories match “${query}”.` : "No repositories found."}
              </p>
            )}
            {visible.map((repo, i) => (
              <button
                key={repo.githubRepoId}
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === active}
                tabIndex={-1}
                disabled={connectingId !== null}
                onClick={() => void choose(repo)}
                onMouseMove={() => setActive(i)}
                ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm disabled:opacity-50",
                  i === active && "bg-accent",
                )}
              >
                <span className="flex-1 truncate">{repo.fullName}</span>
                {repo.private && <Lock className="text-muted-foreground size-3 shrink-0" />}
                {connectingId === repo.githubRepoId && (
                  <Spinner className="size-3 shrink-0" />
                )}
              </button>
            ))}
          </div>

          {/* The list may be short: say why rather than let a missing
              repository look like one that isn't there. */}
          {listing && (listing.ssoPartialOrgIds.length > 0 || !listing.complete) && (
            <p className="text-muted-foreground border-border border-t px-3 py-2 text-xs">
              {listing.ssoPartialOrgIds.length > 0
                ? "Some organizations' repositories are hidden until you authorize Outrunner for their single sign-on on GitHub."
                : "GitHub may have more repositories than this list shows."}
            </p>
          )}

          {extra && (
            <div className="border-border border-t">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  extra.onClick();
                }}
                className="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
              >
                {extra.icon} {extra.label}
              </button>
            </div>
          )}

          <div className="border-border border-t">
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading}
              className="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left text-sm disabled:opacity-50"
            >
              {loading ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />} Refresh list
            </button>
          </div>

          {error && (
            <p className="text-destructive border-border border-t px-3 py-2 text-xs">
              {error.message}
              {error.reconnect && <GitHubReconnectLink />}
            </p>
          )}

          <div className="border-border relative border-t">
            <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              // ↑/↓ move through the list, Enter picks; typing filters it.
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (visible.length === 0) return;
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setActive((i) => (i + step + visible.length) % visible.length);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const repo = visible[active];
                  if (repo && connectingId === null) void choose(repo);
                }
              }}
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={visible[active] ? `${listId}-${active}` : undefined}
              aria-autocomplete="list"
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
