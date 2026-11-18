"use client";

import { ChevronDown, Layers, Lock, RefreshCw, Search } from "lucide-react";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { repositoryKey, type CodeProvider } from "@/lib/code-providers/repository";
import { ProjectAvatar } from "@/components/project-avatar";
import { AppSourceNote, PickerErrorMessage } from "@/components/repository-source-note";
import { Spinner } from "@/components/ui/loaders";
import { useCloseWhenHidden } from "@/hooks/use-close-when-hidden";
import { useSharedResource } from "@/hooks/use-shared-resource";
import { type Placement, placeMenu } from "@/lib/client/menu-placement";
import {
  ConnectError,
  connectRepositories,
  type PickerError,
  projectOf,
  refreshListing,
  repositoryListing,
} from "@/lib/client/repository-listing";
import type { ListedEnvironment } from "@/lib/environments/listed";
import { projectToListing, type RepositoryListing } from "@/lib/github/listing";
import type { Project } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

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


/** One row of the menu: an environment, or a repository. */
type Option = { kind: "environment"; environment: ListedEnvironment } | { kind: "repo"; repo: RepositoryListing };

function optionKey(option: Option): string {
  return option.kind === "environment" ? `environment:${option.environment.id}` : repositoryKey(option.repo);
}

/**
 * Pick where a session starts: one of the org's environments (`environments`,
 * lib/environments/listed.ts), or a repository — from everything on the
 * user's GitHub, not only what they connected earlier — which starts from
 * its own environment.
 *
 * Connecting is implicit: choosing a repository that has no project row
 * connects it (lib/client/repository-listing.ts connectRepositories, as the
 * environments' picker does), then selects it. Making "connect" a separate
 * step people had to find first meant the list only ever showed what you
 * had already added, which is backwards from how you actually reach for a
 * repo.
 *
 * The listing is fetched as the form mounts and again as it opens — it is a
 * live GitHub call (reused for a few seconds by the server); environments
 * and connected repositories show before it answers.
 */
export function RepositorySelect({
  projects = [],
  selectedProjectId = null,
  onSelect,
  environments = [],
  selectedEnvironmentId = null,
  onSelectEnvironment,
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
  /** The environments to offer above the repositories, picked with
   *  `onSelectEnvironment`; the one selected shows on the trigger. */
  environments?: ListedEnvironment[];
  selectedEnvironmentId?: string | null;
  onSelectEnvironment?: (environment: ListedEnvironment) => void;
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
  const [provider, setProvider] = useState<CodeProvider>(() => projects.find((p) => p.id === selectedProjectId)?.provider ?? "github");
  const resource = repositoryListing(provider);
  const repositories = useSharedResource(resource);
  const listing = repositories.value?.listing ?? null;
  const [refreshing, setRefreshing] = useState(false);
  const loading = repositories.status === "loading" || refreshing;
  // Looked up as the form mounts, so the picker opens on it at once.
  useEffect(() => {
    void resource.refresh();
  }, [resource]);
  // Connecting one that failed; the listing's own failure is its answer's.
  const [connectError, setError] = useState<PickerError | null>(null);
  const error = connectError ?? repositories.value?.error ?? null;
  const [query, setQuery] = useState("");
  const [connectingId, setConnectingId] = useState<string | null>(null);
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

  const selectedEnvironment = environments.find((e) => e.id === selectedEnvironmentId);
  const selected = projects.find((p) => p.id === selectedProjectId);

  /** On opening, look again in the background (the last listing shows
   *  meanwhile); Refresh list asks GitHub itself, and waits. */
  async function load(force = false) {
    if (!force) {
      void resource.refresh();
      return;
    }
    if (refreshing) return;
    setRefreshing(true);
    await refreshListing(provider);
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

  // Environments first (matched by name or by a repository of theirs), then
  // repositories: one list, so the arrow keys run through both.
  const visible = useMemo((): Option[] => {
    const q = query.trim().toLowerCase();
    const shownEnvironments = environments.filter(
      (e) => !q || e.name.toLowerCase().includes(q) || e.repos.some((r) => r.fullName.toLowerCase().includes(q)),
    );
    const repos =
      listing?.repositories ??
      // Before the live list arrives, offer what is already connected so the
      // menu is never empty.
      projects.filter((p) => (p.provider ?? "github") === provider).map(projectToListing);
    return [
      ...shownEnvironments.map((environment): Option => ({ kind: "environment", environment })),
      ...(q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : repos).map((repo): Option => ({ kind: "repo", repo })),
    ];
  }, [environments, listing, projects, query, provider]);
  const firstRepo = visible.findIndex((o) => o.kind === "repo");

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  async function choose(option: Option) {
    if (option.kind === "environment") {
      onSelectEnvironment?.(option.environment);
      close();
      return;
    }
    const repo = option.repo;
    if (onPick) {
      close();
      onPick(repo);
      return;
    }
    const existing = projectOf(projects, repo);
    if (existing) {
      onSelect?.(existing);
      close();
      return;
    }
    // Not connected yet — connect just this one, then select it.
    setConnectingId(repositoryKey(repo));
    try {
      const id = provider === "gitlab" ? repo.repositoryId : repo.githubRepoId;
      const created = id ? projectOf(await connectRepositories([id], provider), repo) : undefined;
      if (!created) {
        setError({ message: "Connected it, but Outrunner couldn't find it afterwards. Refresh the list.", reconnect: false, repo: repo.fullName });
        return;
      }
      setError(null);
      onSelect?.(created);
      close();
    } catch (cause) {
      setError(
        cause instanceof ConnectError
          ? { message: cause.message, reconnect: cause.reconnect, noAccess: cause.noAccess, repo: repo.fullName }
          : { message: "Couldn't connect this repository. Try again.", reconnect: false, repo: repo.fullName },
      );
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
        ) : selectedEnvironment ? (
          <>
            <Layers className="shrink-0" aria-hidden />
            <span className="truncate" title={selectedEnvironment.repos.map((r) => r.fullName).join(", ")}>
              {selectedEnvironment.name}
            </span>
          </>
        ) : (
          <>
            <ProjectAvatar name={selected?.name ?? "?"} className="size-5" />
            {selected?.name ?? (environments.length > 0 ? "Select environment…" : "Select repository…")}
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
          <div className="flex shrink-0 gap-1 border-b border-border p-1" role="group" aria-label="Code provider">
            {(["github", "gitlab"] as const).map((id) => <button key={id} type="button" disabled={connectingId !== null} aria-pressed={provider === id}
              onClick={() => { setProvider(id); setQuery(""); setActive(0); setError(null); }}
              className={cn("flex-1 rounded-md px-3 py-1.5 text-sm", provider === id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent")}>
              {id === "github" ? "GitHub" : "GitLab"}
            </button>)}
          </div>
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
                  const option = visible[active];
                  if (option && connectingId === null) void choose(option);
                }
              }}
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={visible[active] ? `${listId}-${active}` : undefined}
              aria-autocomplete="list"
              placeholder={environments.length > 0 ? "Search environments and repositories…" : "Search repositories…"}
              aria-label={environments.length > 0 ? "Search environments and repositories" : "Search repositories"}
              className="placeholder:text-muted-foreground w-full bg-transparent py-2.5 pl-9 pr-3 text-base outline-none sm:text-sm"
            />
          </div>

          {/* The one part that gives way when the room is short. */}
          <div
            id={listId}
            role="listbox"
            aria-label={environments.length > 0 ? "Environments and repositories" : "Repositories"}
            className="max-h-72 min-h-0 overflow-y-auto py-1"
          >
            {visible.map((option, i) => (
              <Fragment key={optionKey(option)}>
                {environments.length > 0 && (i === 0 || i === firstRepo) && (
                  <p role="presentation" className="text-muted-foreground px-3 pb-1 pt-2 text-xs">
                    {option.kind === "environment" ? "Environments" : "Repositories"}
                  </p>
                )}
                <button
                  id={`${listId}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  disabled={connectingId !== null}
                  onClick={() => void choose(option)}
                  onMouseMove={() => setActive(i)}
                  ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm disabled:opacity-50",
                    i === active && "bg-accent",
                  )}
                >
                  {option.kind === "environment" ? (
                    <>
                      <Layers className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{option.environment.name}</span>
                      {option.environment.orgDefault && <span className="text-muted-foreground shrink-0 text-xs">Default</span>}
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {option.environment.repos.length === 1 ? "1 repository" : `${option.environment.repos.length} repositories`}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 truncate">{option.repo.fullName}</span>
                      {option.repo.private && <Lock className="text-muted-foreground size-3 shrink-0" />}
                      {connectingId === repositoryKey(option.repo) && <Spinner className="size-3 shrink-0" />}
                    </>
                  )}
                </button>
              </Fragment>
            ))}
            {repositories.status === "loading" && (
              /* Only before the first answer: the page looks once as the form mounts. */
              <p className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-sm">
                <Spinner className="size-4" /> Loading repositories…
              </p>
            )}
            {!loading && visible.length === 0 && (
              <p className="text-muted-foreground px-3 py-2 text-sm">
                {query ? `Nothing matches “${query}”.` : "No repositories found."}
              </p>
            )}
          </div>

          {/* The list may be short: say why rather than let a missing
              repository look like one that isn't there. */}
          {listing && (listing.ssoPartialOrgIds.length > 0 || !listing.complete) && (
            <p className="text-muted-foreground border-border shrink-0 border-t px-3 py-2 text-xs">
              {listing.ssoPartialOrgIds.length > 0
                ? "Some organizations' repositories are hidden until you authorize Outrunner for their single sign-on on GitHub."
                : `${provider === "gitlab" ? "GitLab" : "GitHub"} may have more repositories than this list shows.`}
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
              <PickerErrorMessage error={error} listing={listing} provider={provider} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
