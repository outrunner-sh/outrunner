"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, Cloud, FolderOpen, Laptop, Lock, RefreshCw, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { RepositoryAccessNotes } from "@/components/repository-access-notes";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/loaders";
import { useGitHubRepositories } from "@/hooks/use-github-repositories";
import { savedLocation } from "@/hooks/use-session-location";
import {
  cloneLocalRepository,
  cloneLocation,
  pickCloneLocation,
  type CloneLocation,
  type LocalFolder,
} from "@/lib/desktop/local-runtime";
import {
  avatarAt,
  filterRepositories,
  groupRepositories,
  parseGitHubRepoInput,
  type RepositoryGroup,
  type RepositoryListing,
} from "@/lib/github/listing";
import type { Project } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

/** What opening a repository made: a project for the cloud, or a clone on
 *  this Mac. */
export type OpenedProject = { kind: "cloud"; project: Project } | { kind: "mac"; folder: LocalFolder };

type Row =
  | { kind: "owner"; group: RepositoryGroup }
  | { kind: "repo"; repo: RepositoryListing; index: number };

const OWNER_ROW_PX = 32;
const REPO_ROW_PX = 36;
const REPO_ROW_WITH_DESCRIPTION_PX = 50;

/** The list's rows: each owner's heading, then its repositories. `index`
 *  counts repositories only, which the arrow keys move through. */
function toRows(groups: RepositoryGroup[]): { rows: Row[]; repos: RepositoryListing[] } {
  const rows: Row[] = [];
  const repos: RepositoryListing[] = [];
  for (const group of groups) {
    rows.push({ kind: "owner", group });
    for (const repo of group.repos) {
      rows.push({ kind: "repo", repo, index: repos.length });
      repos.push(repo);
    }
  }
  return { rows, repos };
}

/**
 * Open a GitHub repository as a project: paste its URL, or pick it from
 * every repository the user can reach — their own first, then each
 * organization's, all of them for one they administer — with notes on any
 * organization holding repositories back and invitations waiting on GitHub.
 *
 * The list is read anew each time the dialog opens, so a repository the user
 * was just added to is there. Opening one connects it (if it wasn't) for the
 * cloud — or, where sessions can run on this Mac (`macPossible`) and that is
 * chosen, clones it into the clone location, which Browse changes — and hands
 * the result to `onOpened`.
 */
export function OpenGitHubProjectDialog({
  open,
  onOpenChange,
  viewerLogin,
  macPossible = false,
  onOpened,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The signed-in user's GitHub login: their own repositories list first. */
  viewerLogin: string | null;
  /** In the Mac app with local sessions on: offer to clone to this Mac. */
  macPossible?: boolean;
  onOpened: (opened: OpenedProject) => void;
}) {
  // Opening a repository can't be walked away from halfway: the dialog stays
  // until it lands or fails.
  const [opening, setOpening] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => !opening && onOpenChange(next)}>
      <DialogContent
        className="max-w-xl gap-0 p-0"
        // The body puts focus in the search field itself (Radix would pick the
        // first button, which reads as a choice already made).
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {/* Mounted only while open, so each opening starts clean. */}
        <OpenGitHubProjectBody
          viewerLogin={viewerLogin}
          macPossible={macPossible}
          onOpened={onOpened}
          opening={opening}
          setOpening={setOpening}
        />
      </DialogContent>
    </Dialog>
  );
}

function OpenGitHubProjectBody({
  viewerLogin,
  macPossible,
  onOpened,
  opening,
  setOpening,
}: {
  viewerLogin: string | null;
  macPossible: boolean;
  onOpened: (opened: OpenedProject) => void;
  opening: boolean;
  setOpening: (opening: boolean) => void;
}) {
  const github = useGitHubRepositories();
  const { list, loading, load } = github;
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Fresh each time it opens: a repository just shared with the user, or an
  // organization just joined, shows without waiting out the server's cache.
  // Once, on mount: `load` changes as the list arrives, and an effect on it
  // would read the list again each time it came in.
  const loadFresh = useRef(() => load(true));
  useEffect(() => {
    void loadFresh.current();
  }, []);

  // Where it opens: the cloud, or (in the Mac app) a clone on this Mac,
  // starting from where the last session ran.
  const [where, setWhere] = useState<"cloud" | "mac">(() =>
    macPossible && savedLocation() === "local" ? "mac" : "cloud",
  );
  const [location, setLocation] = useState<CloneLocation | null>(null);
  useEffect(() => {
    if (!macPossible) return;
    let live = true;
    void cloneLocation()
      .then((answer) => {
        if (live) setLocation(answer);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [macPossible]);

  async function browseLocation() {
    try {
      const picked = await pickCloneLocation();
      if (picked) setLocation(picked);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't choose that folder.");
    }
  }

  const { rows, repos } = useMemo(
    () => toRows(groupRepositories(filterRepositories(list?.repositories ?? [], query), viewerLogin)),
    [list, query, viewerLogin],
  );
  const connected = useMemo(() => new Set(list?.connected ?? []), [list]);

  const activeRepo = repos[Math.min(active, repos.length - 1)] ?? null;
  const pasted = url.trim();

  function moveActive(step: number) {
    if (repos.length === 0) return;
    setActive((active + step + repos.length) % repos.length);
  }

  /** Open a repository by its id in the list, or the `owner/name` of a URL. */
  async function openRepository(ref: number | string) {
    if (opening) return;
    setOpening(true);
    setProblem(null);
    try {
      if (where === "mac") {
        const fullName =
          typeof ref === "string" ? ref : list?.repositories.find((repo) => repo.githubRepoId === ref)?.fullName;
        if (!fullName) throw new Error("That repository isn't in the list any more. Refresh and try again.");
        onOpened({ kind: "mac", folder: await cloneLocalRepository(fullName) });
      } else {
        onOpened({ kind: "cloud", project: await github.connect(ref) });
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not open that repository.");
    } finally {
      setOpening(false);
    }
  }

  /** The pasted URL if there is one, else the repository picked in the list. */
  function openChosen() {
    if (pasted) {
      const fullName = parseGitHubRepoInput(pasted);
      if (!fullName) {
        setProblem("That isn't a GitHub repository URL: try https://github.com/owner/repo.");
        return;
      }
      void openRepository(fullName);
      return;
    }
    if (activeRepo) void openRepository(activeRepo.githubRepoId);
  }

  const activeOptionId = activeRepo ? `${listId}-${activeRepo.githubRepoId}` : undefined;

  return (
    <div
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          openChosen();
        }
      }}
    >
        <div className="space-y-1 px-6 pt-6 pb-4">
          <DialogTitle>Open GitHub project</DialogTitle>
          <DialogDescription>Paste a repository&apos;s URL, or pick one of yours.</DialogDescription>
        </div>

        <div className="space-y-4 px-6">
          {macPossible && (
            <div role="radiogroup" aria-label="Where it runs" className="flex gap-2">
              {(
                [
                  ["cloud", "Cloud", <Cloud key="cloud" className="size-4" />],
                  ["mac", "This Mac", <Laptop key="mac" className="size-4" />],
                ] as const
              ).map(([value, label, icon]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={where === value}
                  disabled={opening}
                  onClick={() => setWhere(value)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm transition-colors",
                    where === value
                      ? "border-foreground/60 bg-accent text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {icon} {label}
                </button>
              ))}
            </div>
          )}

          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Repository URL</span>
            <Input
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setProblem(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
                  event.preventDefault();
                  openChosen();
                }
              }}
              placeholder="https://github.com/owner/repo"
              spellCheck={false}
              autoComplete="off"
              disabled={opening}
            />
          </label>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Your repositories</span>
              <button
                type="button"
                onClick={() => void load(true)}
                disabled={loading}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs disabled:opacity-50"
              >
                {loading ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />} Refresh
              </button>
            </div>
            <div className="border-input overflow-hidden rounded-md border">
              <div className="border-border relative border-b">
                <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      moveActive(event.key === "ArrowDown" ? 1 : -1);
                    } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
                      event.preventDefault();
                      if (activeRepo) void openRepository(activeRepo.githubRepoId);
                    }
                  }}
                  role="combobox"
                  aria-expanded
                  aria-controls={listId}
                  aria-activedescendant={activeOptionId}
                  aria-autocomplete="list"
                  aria-label="Search repositories"
                  placeholder="Search repositories…"
                  className="placeholder:text-muted-foreground w-full bg-transparent py-2 pl-9 pr-3 text-sm outline-none"
                  disabled={opening}
                />
              </div>

              {loading && !list ? (
                <p className="text-muted-foreground flex h-72 items-start gap-2 px-3 py-2 text-sm">
                  <Spinner className="size-4" /> Loading repositories…
                </p>
              ) : rows.length === 0 ? (
                <p className="text-muted-foreground h-72 px-3 py-2 text-sm">
                  {github.error ?? (query ? `No repositories match “${query}”.` : "No repositories found.")}
                </p>
              ) : (
                <RepositoryOptions
                  listId={listId}
                  rows={rows}
                  active={active}
                  connected={connected}
                  disabled={opening}
                  onHover={setActive}
                  onOpen={(repo) => void openRepository(repo.githubRepoId)}
                />
              )}

              {list && <RepositoryAccessNotes access={list.access} complete={list.complete} />}
            </div>
            {list && github.error && <p className="text-destructive text-xs">{github.error}</p>}
          </div>

          {where === "mac" && (
            <div className="space-y-1.5">
              <span className="text-sm font-medium">Location</span>
              <div className="flex gap-2">
                <p
                  className="border-input text-muted-foreground flex h-9 min-w-0 flex-1 items-center truncate rounded-md border px-3 font-mono text-xs"
                  title={location?.path}
                >
                  {location?.path ?? "~/outrunner/repos"}
                </p>
                <Button variant="outline" onClick={() => void browseLocation()} disabled={opening}>
                  <FolderOpen className="size-4" /> Browse
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-6 pt-4 pb-6">
          <p aria-live="polite" className="text-destructive min-h-4 text-xs">
            {problem}
          </p>
          <Button onClick={openChosen} disabled={opening || (!pasted && !activeRepo)}>
            {opening && <Spinner className="size-4" />}
            {where === "mac" ? (opening ? "Cloning" : "Clone") : "Open"}
            <kbd className="text-primary-foreground/70 ml-1 text-xs">⌘↵</kbd>
          </Button>
        </div>
    </div>
  );
}

/**
 * The rows, drawn only as they scroll into view: an organization's owner can
 * reach thousands of repositories. Keeps the active one in view as the arrow
 * keys move it, and goes back to the top when the rows change (a search).
 */
function RepositoryOptions({
  listId,
  rows,
  active,
  connected,
  disabled,
  onHover,
  onOpen,
}: {
  listId: string;
  rows: Row[];
  active: number;
  connected: ReadonlySet<number>;
  disabled: boolean;
  onHover: (index: number) => void;
  onOpen: (repo: RepositoryListing) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // TanStack Virtual hands back fresh functions each render, so the React
  // Compiler leaves this one component unmemoized; it is only the list.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const row = rows[i];
      if (row.kind === "owner") return OWNER_ROW_PX;
      return row.repo.description ? REPO_ROW_WITH_DESCRIPTION_PX : REPO_ROW_PX;
    },
    overscan: 8,
  });

  useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [rows, virtualizer]);

  useEffect(() => {
    const rowIndex = rows.findIndex((row) => row.kind === "repo" && row.index === active);
    if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: "auto" });
  }, [active, rows, virtualizer]);

  return (
    <div ref={scrollRef} className="h-72 overflow-y-auto">
      <div
        id={listId}
        role="listbox"
        aria-label="Repositories"
        className="relative"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <div
              key={item.key}
              className="absolute inset-x-0 top-0"
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              {row.kind === "owner" ? (
                <OwnerHeading group={row.group} />
              ) : (
                <RepoOption
                  id={`${listId}-${row.repo.githubRepoId}`}
                  repo={row.repo}
                  active={row.index === active}
                  connected={connected.has(row.repo.githubRepoId)}
                  disabled={disabled}
                  onHover={() => onHover(row.index)}
                  onOpen={() => onOpen(row.repo)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OwnerHeading({ group }: { group: RepositoryGroup }) {
  return (
    <div className="bg-background text-muted-foreground flex h-full items-end gap-2 px-3 pb-1 text-xs">
      <OwnerAvatar src={group.avatarUrl} />
      <span className="text-foreground font-medium">{group.owner}</span>
      <span>
        {group.viewer ? "Personal" : group.ownerType === "Organization" ? "Organization" : null}
      </span>
      <span className="ml-auto tabular-nums">{group.repos.length}</span>
    </div>
  );
}

function RepoOption({
  id,
  repo,
  active,
  connected,
  disabled,
  onHover,
  onOpen,
}: {
  id: string;
  repo: RepositoryListing;
  active: boolean;
  connected: boolean;
  disabled: boolean;
  onHover: () => void;
  onOpen: () => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={active}
      tabIndex={-1}
      disabled={disabled}
      onMouseMove={onHover}
      onClick={onOpen}
      className={cn(
        "flex h-full w-full flex-col justify-center px-3 pl-9 text-left disabled:opacity-50",
        active && "bg-accent",
      )}
    >
      <span className="flex w-full items-center gap-1.5 text-sm">
        <span className="truncate">{repo.name}</span>
        {repo.private && <Lock aria-label="Private" className="text-muted-foreground size-3 shrink-0" />}
        {connected && (
          <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-1 text-xs">
            <Check className="size-3" /> Added
          </span>
        )}
      </span>
      {repo.description && (
        <span className="text-muted-foreground w-full truncate text-xs">{repo.description}</span>
      )}
    </button>
  );
}

function OwnerAvatar({ src }: { src: string | null }) {
  if (!src) return <span aria-hidden className="bg-muted size-4 shrink-0 rounded-sm" />;
  // eslint-disable-next-line @next/next/no-img-element -- GitHub's avatar CDN, sized by query
  return <img src={avatarAt(src, 32)} alt="" loading="lazy" className="size-4 shrink-0 rounded-sm" />;
}
