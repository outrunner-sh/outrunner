"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Archive,
  ChevronRight,
  Ellipsis,
  GitBranchPlus,
  Folder,
  GitPullRequest,
  Inbox,
  Slack,
  Laptop,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Settings2,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { AppUpdate } from "@/components/app-update";
import { ArchiveSessionDialog } from "@/components/archive-session-dialog";
import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import { GetStarted } from "@/components/get-started";
import { HomeUserMenu } from "@/components/home-user-menu";
import { OutrunnerAllowance } from "@/components/outrunner-allowance";
import { Spinner } from "@/components/ui/loaders";
import { SIDEBAR_ROW } from "@/components/ui/sidebar-row";
import { SkeletonRows, SkeletonSwap } from "@/components/ui/skeleton-swap";
import { useLocalSessions } from "@/hooks/use-local-sessions";
import { useNow } from "@/hooks/use-now";
import { startNextSessionIn, startNextSessionInCloud } from "@/hooks/use-session-location";
import {
  activeSessionId,
  buildSidebarGroups,
  filterSidebarGroups,
  newSessionHref,
  relativeTime,
  rememberFoldedProjects,
  type SessionDeletion,
  shownSessions,
  type SidebarGroup,
} from "@/lib/nav/sidebar";
import type { NavProject } from "@/lib/nav/workspace-nav-groups";
import type { Workspace } from "@/lib/runtime/types";
import { LOCAL_SESSIONS } from "@/lib/session/local-sessions";
import { startNewSession } from "@/lib/session/new-session-reset";
import { cancelWarmOnRest, warmOnRest, warmSession } from "@/lib/session/warm-session";
import { cn } from "@/lib/utils";
import { OrgSwitcher } from "@/components/org-switcher";
import type { Org } from "@/lib/orgs/active";

/**
 * The one sidebar every app page shares (rendered by app/(app)/layout.tsx, so
 * it stays put while you move between sessions): the primary actions, then
 * every workspace with its sessions nested underneath (cloud repositories and
 * this Mac's folders together, newest activity first), then the user.
 */
export function AppSidebar({
  loading = false,
  projects,
  workspaces,
  ownerLogin,
  ownerAvatarUrl,
  orgs = [],
  activeOrgId = null,
  triageCount = 0,
  onCollapse,
  searchSignal = 0,
  initialFolded = [],
  getStartedSkipped = null,
}: {
  /** What it lists hasn't arrived yet (a cold start): rows held by a skeleton. */
  loading?: boolean;
  projects: NavProject[];
  workspaces: Workspace[];
  ownerLogin: string;
  ownerAvatarUrl: string | null;
  /** The user's orgs, for the switcher in the header; none before they load. */
  orgs?: Org[];
  /** The org the sidebar lists. */
  activeOrgId?: string | null;
  /** Work items waiting in triage, shown beside its link. */
  triageCount?: number;
  onCollapse: () => void;
  /** Changes each time ⌘K is pressed: open the search field. */
  searchSignal?: number;
  /** The projects folded shut, by group key (from their cookie). */
  initialFolded?: string[];
  /** The "Get started" checklist skipped (from its cookie); null until read. */
  getStartedSkipped?: boolean | null;
}) {
  const pathname = usePathname();
  const active = activeSessionId(pathname);
  const local = useLocalSessions();
  const { refresh: refreshLocal } = local;
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  // Ages the rows' "5m"/"2h" labels while the sidebar stays mounted.
  const now = useNow(60_000);

  // The sidebar outlives page changes, so re-read this Mac's sessions on each
  // one: a session just made or deleted elsewhere shows up without a focus.
  useEffect(() => {
    refreshLocal();
  }, [pathname, refreshLocal]);

  const groups = useMemo(
    // `now` too: a setup that stalls becomes deletable as the clock passes it.
    () => buildSidebarGroups(projects, workspaces, local.sessions, { now }),
    [projects, workspaces, local.sessions, now],
  );
  const shown = filterSidebarGroups(groups, query);

  // Projects folded shut with their chevron, remembered across visits.
  // Toggled here; else as the cookie had them, once read.
  const [foldedChoice, setFolded] = useState<string[] | null>(null);
  const folded = foldedChoice ?? initialFolded;
  const toggleFolded = (key: string) => {
    const next = folded.includes(key) ? folded.filter((k) => k !== key) : [...folded, key];
    setFolded(next);
    rememberFoldedProjects(next);
  };

  // The session whose delete confirmation is open. Leave it before deleting
  // when it is the one on screen: its page reconnects when the session stops,
  // and would ask to start it again mid-delete. Once it is gone, re-read both
  // lists.
  const [deleting, setDeleting] = useState<DeletingSession | null>(null);
  const router = useRouter();
  const onDeleting = (id: string) => {
    if (id === active) router.push("/");
  };
  const onDeleted = () => {
    router.refresh();
    refreshLocal();
  };

  // The session whose archive confirmation is open. Once it is archived, leave
  // it if it is the one on screen (left open, its page would restore it at
  // once), and re-read the list, which then marks it archived.
  const [archiving, setArchiving] = useState<ArchivingSession | null>(null);
  const onArchived = (id: string) => {
    if (id === active) router.push("/");
    router.refresh();
  };

  // ⌘K (AppFrame): open search, which focuses its field as it mounts.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (searchSignal > 0) setSearching(true);
  }, [searchSignal]);

  const closeSearch = () => {
    setQuery("");
    setSearching(false);
  };

  return (
    <aside className="flex h-full min-h-0 flex-col gap-5 border-r border-border/60 bg-sidebar px-3 pb-3 pt-5">
      <div className="flex items-center justify-between gap-2 px-2">
        {/* The org being shown, which switches orgs; before they've loaded
            (or with none, before orgs), the app's mark, home. */}
        {orgs.length > 0 ? (
          <OrgSwitcher orgs={orgs} activeOrgId={activeOrgId} />
        ) : (
          <Link href="/" aria-label="Home" className="flex items-center text-foreground">
            <Terminal className="size-4" />
          </Link>
        )}
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          className="-mr-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelLeft className="size-4" />
        </button>
      </div>

      <nav className="space-y-0.5" aria-label="Main">
        {/* Home is the new-session screen too. */}
        <NavLink
          href="/new"
          onClick={startNewSession}
          icon={<Plus />}
          label="New Session"
          hint="⌘N"
          active={pathname === "/" || pathname === "/new"}
        />
        {/* Import (/import) is hidden from the nav for now; the page still works. */}
        <NavLink
          href="/triage"
          icon={<Inbox />}
          label="Triage"
          hint="⌘I"
          count={triageCount}
          active={pathname === "/triage"}
        />
        {/* The org's open pull requests: ask about one, send it back, merge. */}
        <NavLink
          href="/review"
          icon={<GitPullRequest />}
          label="Review"
          active={pathname === "/review" || pathname.startsWith("/review/")}
        />
        {/* The org's automations, which post as the Outrunner GitHub App. */}
        <NavLink
          href="/automations"
          icon={<Sparkles />}
          label="Automations"
          active={pathname === "/automations" || pathname.startsWith("/automations/")}
        />
        {searching ? (
          <SearchField value={query} onChange={setQuery} onClose={closeSearch} />
        ) : (
          <NavButton icon={<Search />} label="Search" hint="⌘K" onClick={() => setSearching(true)} />
        )}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-center justify-between px-2">
          <h2 className="text-[13px] text-muted-foreground">Projects</h2>
          {/* Opens the new-session screen with its GitHub repository picker
              open (`?pick=repo`): the way to add a repository not listed yet. */}
          <Link
            href="/new?pick=repo"
            onClick={startNewSession}
            aria-label={ADD_PROJECT_LABEL}
            title={ADD_PROJECT_LABEL}
            className="-mr-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <GitBranchPlus className="size-3.5" />
          </Link>
        </div>
        {/* What it lists streams in on a cold start, and this Mac's sessions are
            read from the agent after the page loads, so the list waits for
            both rather than reshuffling as they land. */}
        <SkeletonSwap
          ready={!loading && local.state !== "loading"}
          skeleton={<SidebarSkeleton />}
          label="Sessions"
          className="mt-2"
        >
          <div className="space-y-3">
            {shown.length === 0 ? (
              <p className="px-2 py-1 text-[13px] text-muted-foreground">
                {query ? "No matching sessions" : "No sessions yet"}
              </p>
            ) : (
              shown.map((group) => (
                <WorkspaceGroup
                  key={group.key}
                  group={group}
                  active={active}
                  now={now}
                  onDelete={setDeleting}
                  onArchive={setArchiving}
                  folded={folded.includes(group.key)}
                  searching={query.trim() !== ""}
                  onToggle={() => toggleFolded(group.key)}
                />
              ))
            )}
          </div>
        </SkeletonSwap>
      </div>

      <DeleteSessionDialog
        session={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        onDeleting={onDeleting}
        onDeleted={onDeleted}
      />
      <ArchiveSessionDialog
        session={archiving}
        onOpenChange={(open) => {
          if (!open) setArchiving(null);
        }}
        onArchived={onArchived}
      />

      {/* Counted once both lists are in, so no step reads undone as they land;
          a project is one the list above shows. */}
      {!loading && local.state !== "loading" && (
        <GetStarted
          projects={groups.length}
          sessions={workspaces.length + local.sessions.length}
          skipped={getStartedSkipped}
        />
      )}
      <OutrunnerAllowance />
      <AppUpdate />
      <div className="flex items-center gap-1 border-t border-border/60 pt-3">
        <div className="min-w-0 flex-1">
          <HomeUserMenu ownerLogin={ownerLogin} ownerAvatarUrl={ownerAvatarUrl} />
        </div>
        <Link
          href="/settings/general"
          aria-label="Settings"
          title="Settings"
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Settings className="size-4" />
        </Link>
      </div>
    </aside>
  );
}

/** A workspace and its sessions. Its name folds them away and back (the
 *  chevron says which); the `+` starts a new session in it, where there is a
 *  repository (or folder) to start one in. One with no session yet has a
 *  "New session" row in their place. */
function WorkspaceGroup({
  group,
  active,
  now,
  onDelete,
  onArchive,
  folded,
  searching,
  onToggle,
}: {
  group: SidebarGroup;
  active?: string;
  now: number;
  /** Opens the delete confirmation for one of its sessions. */
  onDelete: (session: DeletingSession) => void;
  /** Opens the archive confirmation for one of its sessions. */
  onArchive: (session: ArchivingSession) => void;
  folded: boolean;
  searching: boolean;
  onToggle: () => void;
}) {
  const listId = useId();
  const router = useRouter();
  const { start } = group;
  // Set the form's cloud/Mac choice, then open a fresh form for this target
  // (startNewSession: a new form each click, even for the URL already open).
  const startHere = () => {
    if (!start) return;
    if (start.kind === "local") startNextSessionIn(start.folder);
    else startNextSessionInCloud();
    startNewSession();
    router.push(newSessionHref(start));
  };
  const Icon = group.local ? Laptop : Folder;
  return (
    <div>
      <div className="group/ws flex items-center gap-2.5 rounded-md px-2 py-1 text-[13px] text-foreground">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!folded}
          aria-controls={listId}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate" title={group.local ? `${group.detail} · this Mac` : group.detail}>
            {group.label}
          </span>
          {/* Always there when folded, so a folded project reads as one; open,
              it shows on hover, pointing down. */}
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition",
              !folded && "rotate-90 opacity-0 group-hover/ws:opacity-100 group-focus-within/ws:opacity-100",
            )}
          />
        </button>
        {start?.kind === "cloud" && (
          // The project's settings: a repository's id opens its default
          // project (app/(app)/projects/[id]).
          <Link
            href={`/projects/${start.projectId}`}
            aria-label={`${group.label} settings`}
            title={`${group.label} settings`}
            className="rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/ws:opacity-100"
          >
            <Settings2 className="size-3.5" />
          </Link>
        )}
        {start && (
          <button
            type="button"
            onClick={startHere}
            aria-label={`New session in ${group.label}`}
            title={`New session in ${group.label}`}
            className="-mr-1 rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/ws:opacity-100"
          >
            <Plus className="size-3.5" />
          </button>
        )}
      </div>
      <div id={listId}>
        {start && group.sessions.length === 0 && !folded && (
          <button
            type="button"
            onClick={startHere}
            className="flex w-full items-center gap-2 rounded-md py-1 pl-[32px] pr-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <Plus aria-hidden className="size-3.5 shrink-0" />
            New session
          </button>
        )}
        {shownSessions(group, { folded, searching, active }).map((session) => {
          const isActive = session.id === active;
          const { deletion, archive } = session;
          // A cloud session warms up as the pointer rests on it, so its click
          // shows the conversation at once. A Mac one is near already, and
          // attaching would start it.
          const warm = !isActive && !group.local;
          return (
            <div key={session.id} className="group/row relative">
              <Link
                href={session.href}
                onPointerEnter={warm ? () => warmOnRest(session.id) : undefined}
                onPointerLeave={warm ? cancelWarmOnRest : undefined}
                onFocus={warm ? () => warmSession(session.id) : undefined}
                title={session.title}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md py-1 pl-[32px] pr-2 text-[13px] transition-colors",
                  // Room for both of the row's buttons as they show.
                  deletion && archive && "group-hover/row:pr-10 group-focus-within/row:pr-10",
                  isActive
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                {session.slackThreadUrl && (
                  <span title="Started from Slack: it and its thread stay in step" className="shrink-0">
                    <Slack aria-label="From Slack" className="size-3 text-muted-foreground" />
                  </span>
                )}
                {session.archived && (
                  <span title="Archived. Opening it restores it." className="shrink-0">
                    <Archive aria-label="Archived" className="size-3 text-muted-foreground" />
                  </span>
                )}
                <RowTail at={session.at} now={now} hideOnHover={deletion !== null || archive !== null} />
              </Link>
              {archive && (
                <button
                  type="button"
                  // Not `disabled`: a disabled button shows no tooltip saying why.
                  aria-disabled={!archive.can}
                  onClick={() => {
                    if (archive.can) onArchive({ id: session.id, title: session.title });
                  }}
                  aria-label={`Archive ${session.title}`}
                  title={archive.can ? "Archive session" : archive.why}
                  className={cn(
                    "absolute top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 transition focus-visible:opacity-100 group-hover/row:opacity-100",
                    deletion ? "right-7" : "right-1",
                    archive.can ? "hover:bg-accent hover:text-foreground" : "cursor-not-allowed group-hover/row:opacity-40 focus-visible:opacity-40",
                  )}
                >
                  <Archive className="size-3.5" />
                </button>
              )}
              {deletion && (
                <button
                  type="button"
                  onClick={() => onDelete({ id: session.id, title: session.title, deletion })}
                  aria-label={`Delete ${session.title}`}
                  title="Delete session"
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
                >
                  <Ellipsis className="size-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A session row's right end: when it was last active, or, from the click until
 *  its page arrives, a spinner in the same box (useLinkStatus), so a click in
 *  the sidebar always answers. Steps aside on hover for the row's menu. */
function RowTail({ at, now, hideOnHover }: { at: string; now: number; hideOnHover: boolean }) {
  const { pending } = useLinkStatus();
  return (
    <span className={cn("grid shrink-0 place-items-center", hideOnHover && "group-hover/row:invisible")}>
      {/* The server's clock and the browser's differ by the render delay,
          which can tip "59m" into "1h": not a real mismatch. */}
      <time
        dateTime={at}
        suppressHydrationWarning
        className={cn("col-start-1 row-start-1 text-xs text-muted-foreground", pending && "invisible")}
      >
        {relativeTime(at, now)}
      </time>
      {pending && <Spinner label="Opening" className="col-start-1 row-start-1 size-3 text-muted-foreground" />}
    </span>
  );
}

/** Two groups of placeholder rows, at the real rows' height (28px): a project
 *  header, then its sessions indented to where their titles start. */
function SidebarSkeleton() {
  return (
    <div className="space-y-3">
      {[3, 2].map((sessions, i) => (
        <div key={i}>
          <SkeletonRows rows={1} rowHeight={28} indent={32} />
          <SkeletonRows rows={sessions} rowHeight={28} indent={32} />
        </div>
      ))}
    </div>
  );
}

/** The add-project button's name: a GitHub repository, unless local sessions
 *  are on, where the picker it opens can be a folder on the Mac. */
const ADD_PROJECT_LABEL = LOCAL_SESSIONS ? "Add a project" : "Add a repository from GitHub";

type DeletingSession = { id: string; title: string; deletion: SessionDeletion };

type ArchivingSession = { id: string; title: string };

function NavLink({
  href,
  onClick,
  icon,
  label,
  hint,
  count = 0,
  active,
}: {
  href: string;
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  /** Its keyboard shortcut, shown at the row's end on hover. */
  hint?: string;
  /** How many wait there; shown at the row's end, giving way to the hint on hover. */
  count?: number;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-keyshortcuts={hint ? keyShortcut(hint) : undefined}
      className={cn(
        SIDEBAR_ROW,
        "group/nav",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {count > 0 && (
        <span
          aria-label={`${count} waiting`}
          className={cn(
            "text-[11px] tabular-nums text-muted-foreground",
            hint && "group-hover/nav:hidden group-focus-visible/nav:hidden",
          )}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
      {hint && <Kbd hidden={count > 0}>{hint}</Kbd>}
    </Link>
  );
}

function NavButton({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-keyshortcuts={hint ? keyShortcut(hint) : undefined}
      className={cn(SIDEBAR_ROW, "group/nav text-muted-foreground hover:bg-accent hover:text-foreground")}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {hint && <Kbd>{hint}</Kbd>}
    </button>
  );
}

/** A shortcut, shown only while its row is hovered or focused. */
function Kbd({ children, hidden = false }: { children: string; hidden?: boolean }) {
  return (
    <kbd
      className={cn(
        "font-sans text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover/nav:opacity-100 group-focus-visible/nav:opacity-100",
        // Out of the row until hovered, where a count holds its place.
        hidden && "hidden group-hover/nav:inline group-focus-visible/nav:inline",
      )}
    >
      {children}
    </kbd>
  );
}

/** "⌘K" as aria-keyshortcuts spells it. */
function keyShortcut(hint: string): string {
  return hint.replace("⌘", "Meta+");
}

/** "Search" turned into its field: filters the workspaces below as you type.
 *  Escape, the ×, or leaving it empty closes it. */
function SearchField({
  value,
  onChange,
  onClose,
}: {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <div className={cn(SIDEBAR_ROW, "bg-accent/60 text-foreground")}>
      <Search className="text-muted-foreground" />
      <input
        ref={input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        onBlur={() => {
          if (!value.trim()) onClose();
        }}
        placeholder="Search sessions"
        aria-label="Search sessions"
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
      />
      <button
        type="button"
        // Before the input's blur, so a click on × is not lost to it.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
        aria-label="Clear search"
        className="rounded p-0.5 text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
