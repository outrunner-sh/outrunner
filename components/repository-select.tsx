"use client";

import { ChevronDown, Lock, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { GitHubReconnectLink } from "@/components/github-reconnect-link";
import { ProjectAvatar } from "@/components/project-avatar";
import { Spinner } from "@/components/ui/loaders";
import { InlineMessage } from "@/components/ui/notice";
import { useCloseWhenHidden } from "@/hooks/use-close-when-hidden";
import { useSharedResource } from "@/hooks/use-shared-resource";
import { type Placement, placeMenu } from "@/lib/client/menu-placement";
import { sharedResource } from "@/lib/client/shared-resource";
import {
  installationSettingsUrl,
  projectToListing,
  type ListingSource,
  type RepositoryListing,
  type SourceAccount,
} from "@/lib/github/listing";
import type { Project } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

type Listing = {
  repositories: RepositoryListing[];
  connected: number[];
  /** False when GitHub may have more than the list holds. */
  complete: boolean;
  /** Organizations whose repositories single sign-on held back. */
  ssoPartialOrgIds: number[];
  /** The org's GitHub App, or the user's own GitHub. */
  source: ListingSource;
};

/** What went wrong, and for a repository GitHub withheld, which one. */
type PickerError = { message: string; reconnect: boolean; repo?: string; noAccess?: boolean };

// Where a user reviews which organizations an OAuth app may see.
const GITHUB_APP_ACCESS_URL = "https://github.com/settings/applications";

/** Read the API's error body: `reconnect` set when the token is the problem,
 *  `noAccess` when GitHub withheld a repository. */
async function readError(res: Response, fallback: string): Promise<PickerError> {
  const data = (await res.json().catch(() => ({}))) as { error?: string; reconnect?: boolean; code?: string };
  return {
    message: data.error ?? fallback,
    reconnect: data.reconnect === true,
    noAccess: data.code === "repo-no-access",
  };
}

type ListingAnswer = { listing: Listing; error: null } | { listing: null; error: PickerError };

/** The next look asks GitHub again rather than take the server's recent copy. */
let askGitHubAgain = false;

/**
 * Everything on the user's GitHub, one listing for the page: looked up as the
 * form mounts, so the picker opens on it at once, and again in the background
 * each time it opens. A failure is an answer too, said in the picker.
 */
const REPOSITORIES = sharedResource<ListingAnswer | null>(async () => {
  const fresh = askGitHubAgain;
  askGitHubAgain = false;
  try {
    // Refresh asks GitHub again; otherwise a listing from the last few seconds
    // is fine (app/api/github/repositories).
    const res = await fetch(fresh ? "/api/github/repositories?fresh=1" : "/api/github/repositories");
    if (!res.ok) return { listing: null, error: await readError(res, "Couldn't load your repositories from GitHub.") };
    const data = (await res.json()) as Partial<Listing>;
    return {
      listing: {
        repositories: data.repositories ?? [],
        connected: data.connected ?? [],
        complete: data.complete ?? true,
        ssoPartialOrgIds: data.ssoPartialOrgIds ?? [],
        source: data.source ?? { kind: "user" },
      },
      error: null,
    };
  } catch {
    return {
      listing: null,
      error: { message: "Couldn't load your repositories from GitHub.", reconnect: false },
    };
  }
}, null);

/** Ask GitHub again (the picker's Refresh list). */
function refreshRepositories(): Promise<unknown> {
  askGitHubAgain = true;
  REPOSITORIES.invalidate();
  return REPOSITORIES.ensure();
}

const BELOW: Placement = { side: "below" };

/** The menu's height with a full list: below has room enough, it opens there. */
const MENU_HEIGHT = 420;

/**
 * Where the menu fits beside `trigger` (placeMenu). The room is what can be
 * seen: inside the window and every ancestor that scrolls or clips (the
 * new-session form's scroll area clips a menu that rises out of it).
 */
function placement(trigger: HTMLElement | null): Placement {
  if (!trigger) return BELOW;
  const room = { top: 0, bottom: window.innerHeight };
  for (let el = trigger.parentElement; el; el = el.parentElement) {
    if (getComputedStyle(el).overflowY === "visible") continue;
    const box = el.getBoundingClientRect();
    room.top = Math.max(room.top, box.top);
    room.bottom = Math.min(room.bottom, box.bottom);
  }
  return placeMenu(trigger.getBoundingClientRect(), room, MENU_HEIGHT);
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
  autoOpen = false,
  onClosed,
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
  /** Open as it mounts, or as this turns true (the sidebar's add-project
   *  button). */
  autoOpen?: boolean;
  /** The menu is shut. */
  onClosed?: () => void;
}) {
  const [open, setOpen] = useState(autoOpen);
  useEffect(() => {
    if (!open) onClosed?.();
  }, [open, onClosed]);
  useCloseWhenHidden(useCallback(() => setOpen(false), []));
  const repositories = useSharedResource(REPOSITORIES);
  const listing = repositories.value?.listing ?? null;
  const [refreshing, setRefreshing] = useState(false);
  const loading = repositories.status === "loading" || refreshing;
  // Looked up as the form mounts, so the picker opens on it at once.
  useEffect(() => {
    void REPOSITORIES.ensure();
  }, []);
  // Connecting one that failed; the listing's own failure is its answer's.
  const [connectError, setError] = useState<PickerError | null>(null);
  const error = connectError ?? repositories.value?.error ?? null;
  const [query, setQuery] = useState("");
  const [connectingId, setConnectingId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The option the arrow keys are on (a combobox: focus stays in the search
  // field, and this one is announced as active).
  const [active, setActive] = useState(0);
  const listId = useId();
  // Asked again while mounted: open now.
  const [autoOpenSeen, setAutoOpenSeen] = useState(autoOpen);
  if (autoOpen !== autoOpenSeen) {
    setAutoOpenSeen(autoOpen);
    if (autoOpen) {
      setOpen(true);
      setActive(0);
    }
  }

  const selected = projects.find((p) => p.id === selectedProjectId);

  /** On opening, look again in the background (the last listing shows
   *  meanwhile); Refresh list asks GitHub itself, and waits. */
  async function load(force = false) {
    if (!force) {
      void REPOSITORIES.refresh();
      return;
    }
    if (refreshing) return;
    setRefreshing(true);
    await refreshRepositories();
    setRefreshing(false);
    // Asked GitHub and answered: a reason left from connecting a repository
    // gives way to this look's own answer.
    setError(null);
  }

  // Focus search on open so typing filters immediately. The fetch is kicked off
  // from the trigger's click handler rather than here — starting it in an effect
  // sets state during render and cascades.
  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  // Which side of the trigger the menu opens on, and how tall it may be, so
  // it always fits: measured before it paints, and again as the window resizes.
  const [place, setPlace] = useState<Placement>(BELOW);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setPlace(placement(triggerRef.current));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  // Close on outside press / Escape. On pointerdown, not mousedown: a Radix
  // menu's trigger (the model chip) cancels its pointerdown, so no mousedown
  // follows, and both menus stayed open. Touch sends pointerdown too.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
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
    try {
      const res = await fetch("/api/projects/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoIds: [repo.githubRepoId] }),
      });
      if (!res.ok) {
        setError({ ...(await readError(res, "Couldn't connect this repository. Try again.")), repo: repo.fullName });
        return;
      }
      const data = (await res.json()) as { projects?: Project[] };
      const created = data.projects?.find((p) => p.githubRepoId === repo.githubRepoId);
      if (!created) {
        setError({
          message: "Connected it, but Outrunner couldn't find it afterwards. Refresh the list.",
          reconnect: false,
          repo: repo.fullName,
        });
        return;
      }
      setError(null);
      onSelect?.(created);
      setOpen(false);
      triggerRef.current?.focus();
    } catch {
      setError({
        message: "Couldn't connect this repository. Try again.",
        reconnect: false,
        repo: repo.fullName,
      });
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
        <div
          className={cn(
            "bg-popover border-border absolute left-0 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col sm:left-1/2 sm:-translate-x-1/2 overflow-hidden rounded-lg border shadow-xl",
            place.side === "below" ? "top-full mt-2" : "bottom-full mb-2",
          )}
          style={{ maxHeight: place.maxHeight }}
        >
          {/* Search first, focused as it opens. */}
          <div className="border-border relative shrink-0 border-b">
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
              className="placeholder:text-muted-foreground w-full bg-transparent py-2.5 pl-9 pr-3 text-base outline-none sm:text-sm"
            />
          </div>

          {/* The one part that gives way when the room is short. */}
          <div
            id={listId}
            role="listbox"
            aria-label="Repositories"
            className="max-h-72 min-h-0 overflow-y-auto py-1"
          >
            {repositories.status === "loading" && (
              /* Only before the first answer: the page looks once as the form mounts. */
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
            <p className="text-muted-foreground border-border shrink-0 border-t px-3 py-2 text-xs">
              {listing.ssoPartialOrgIds.length > 0
                ? "Some organizations' repositories are hidden until you authorize Outrunner for their single sign-on on GitHub."
                : "GitHub may have more repositories than this list shows."}
            </p>
          )}

          {listing?.source.kind === "app" && <AppSourceNote accounts={listing.source.accounts} />}

          {extra && (
            <div className="border-border shrink-0 border-t">
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

          <div className="border-border shrink-0 border-t">
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
            <div className="border-border shrink-0 border-t px-3 py-2">
              {error.repo && <p className="mb-1 truncate font-mono text-xs">{error.repo}</p>}
              <InlineMessage
                tone={error.noAccess ? "warning" : "error"}
                actions={
                  error.noAccess
                    ? listing?.source.kind === "app"
                      ? [appAccessAction(listing.source, error.repo)]
                      : [{ label: "Grant access on GitHub", href: GITHUB_APP_ACCESS_URL, external: true }]
                    : undefined
                }
              >
                {error.noAccess
                  ? listing?.source.kind === "app"
                    ? "Outrunner's GitHub App can't reach it. Add it to the App's repositories on GitHub."
                    : "GitHub isn't giving Outrunner access to it. If an organization owns it, an owner may need to approve Outrunner."
                  : error.message}
                {error.reconnect && <GitHubReconnectLink />}
              </InlineMessage>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Where the list comes from, in an org with the GitHub App: its
 *  installations, and where to give the App more repositories. */
function AppSourceNote({ accounts }: { accounts: SourceAccount[] }) {
  const suspended = accounts.filter((a) => a.suspended).map((a) => a.login);
  const only = accounts.length === 1 ? accounts[0] : null;
  return (
    <p className="text-muted-foreground border-border shrink-0 border-t px-3 py-2 text-xs">
      {`From Outrunner's GitHub App on ${accounts.map((a) => a.login).join(", ")}. `}
      {suspended.length > 0 && `It's suspended on ${suspended.join(", ")}. `}
      {only ? (
        <a href={installationSettingsUrl(only)} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
          Add repositories
        </a>
      ) : (
        <Link href="/settings/org/github" className="text-foreground underline underline-offset-2">
          Add repositories
        </Link>
      )}
    </p>
  );
}

/** Where to give the App a repository it can't reach: its owner's
 *  installation on GitHub, or the org's GitHub settings. */
function appAccessAction(source: { accounts: SourceAccount[] }, repo: string | undefined) {
  const owner = repo?.split("/")[0]?.toLowerCase();
  const account = source.accounts.find((a) => a.login.toLowerCase() === owner);
  return account
    ? { label: "Add it on GitHub", href: installationSettingsUrl(account), external: true }
    : { label: "Settings → Org → GitHub", href: "/settings/org/github" };
}
