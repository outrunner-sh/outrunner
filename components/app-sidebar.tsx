"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Archive,
  ChevronRight,
  GitBranchPlus,
  Folder,
  GitPullRequest,
  Inbox,
  LayoutList,
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
import { SidebarMissions } from "@/components/missions/sidebar-missions";
import { OutrunnerAllowance } from "@/components/outrunner-allowance";
import { RowTail, SessionMenu, StatusSections } from "@/components/sidebar-status";
import { SIDEBAR_ROW } from "@/components/ui/sidebar-row";
import { SkeletonRows, SkeletonSwap } from "@/components/ui/skeleton-swap";
import { useLocalSessions } from "@/hooks/use-local-sessions";
import { useNow } from "@/hooks/use-now";
import { useStandings } from "@/hooks/use-standings";
import { startNextSessionIn, startNextSessionInCloud } from "@/hooks/use-session-location";
import {
  activeSessionId,
  buildSidebarGroups,
  filterSidebarGroups,
  newSessionHref,
  rememberFoldedProjects,
  type SessionDeletion,
  shownSessions,
  type SidebarGroup,
} from "@/lib/nav/sidebar";
import { buildStatusSections, type Grouping, groupingCookie } from "@/lib/nav/status-groups";
import type { SessionStanding } from "@/lib/session/standing";
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
  initialGrouping = "status",
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
  /** By status or by project (from its cookie). */
  initialGrouping?: Grouping;
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
  // Repositories with no sessions stay in Projects for management, but aren't
  // sidebar destinations until there's a session to show under them.
  const shown = filterSidebarGroups(groups.filter((group) => group.sessions.length > 0), query);

  // By status (where each session stands, lib/session/standing.ts) or by
  // project; switched here, else as the cookie had it.
  const [groupingChoice, setGrouping] = useState<Grouping | null>(null);
  const grouping = groupingChoice ?? initialGrouping;
  const chooseGrouping = (next: Grouping) => {
    setGrouping(next);
    document.cookie = groupingCookie(next);
  };
  const standings = useStandings();
  const sections = useMemo(() => buildStatusSections(shown, standings, now), [shown, standings, now]);
  const needingYou = Object.values(standings).filter((s) => s.standing === "needs_you").length;

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

  // The session whose archive confirmation is open. Once confirmed, leave it
  // if it is the one on screen (left open, its page would restore it at
  // once); the list marks it archived at once (lib/session/optimistic-archive.ts).
  const [archiving, setArchiving] = useState<ArchivingSession | null>(null);
  const onArchived = (id: string) => {
    if (id === active) router.push("/");
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
      <div className="flex min-w-0 items-center gap-1 px-1">
        {/* The org being shown, which switches orgs; before they've loaded
            (or with none, before orgs), the app's mark, home. */}
        {orgs.length > 0 ? (
          <OrgSwitcher orgs={orgs} activeOrgId={activeOrgId} />
        ) : (
          <Link href="/" aria-label="Home" title="Home" className="flex min-w-0 flex-1 items-center text-foreground">
            <Terminal className="size-4" />
          </Link>
        )}
        <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="Workspace navigation">
          <HeaderActionLink
            href="/triage"
            label="Triage"
            count={triageCount}
            countDescription="waiting"
            shortcut="⌘I"
            icon={<Inbox />}
            active={pathname === "/triage"}
          />
          <HeaderActionLink
            href="/workspaces"
            label="Sessions"
            count={needingYou}
            countDescription="need you"
            icon={<LayoutList />}
            active={pathname === "/workspaces"}
          />
          <button
            type="button"
            onClick={() => setSearching(true)}
            aria-label="Search sessions"
            aria-keyshortcuts={keyShortcut("⌘K")}
            aria-pressed={searching}
            title="Search sessions (⌘K)"
            className={cn(
              "relative grid size-6 shrink-0 place-items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              searching
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Search className="size-4" />
          </button>
        </div>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
        <NavLink
          href="/projects"
          icon={<Folder />}
          label="Projects"
          active={pathname === "/projects" || pathname.startsWith("/projects/")}
        />
        {/* Import (/import) is hidden from the nav for now; the page still works. */}
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
        ) : null}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarMissions active={active} projects={projects} />
        <div className="flex items-center justify-between px-2">
          <GroupingSwitch value={grouping} onChange={chooseGrouping} />
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
            {grouping === "status" && sections.length > 0 ? (
              <StatusSections
                sections={sections}
                active={active}
                now={now}
                folded={folded}
                searching={query.trim() !== ""}
                onToggle={toggleFolded}
                onDelete={setDeleting}
                onArchive={setArchiving}
              />
            ) : grouping === "status" || shown.length === 0 ? (
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
                  standings={standings}
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
  standings,
  onDelete,
  onArchive,
  folded,
  searching,
  onToggle,
}: {
  group: SidebarGroup;
  active?: string;
  now: number;
  /** Where each cloud session stands: its unread mark and its menu's marks. */
  standings: Record<string, SessionStanding>;
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
          const standing = group.local ? undefined : standings[session.id];
          const hasMenu = !group.local || deletion !== null || archive !== null;
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
                  // Room for the row's menu as it shows.
                  hasMenu && "group-hover/row:pr-8 group-focus-within/row:pr-8",
                  isActive
                    ? "bg-accent text-foreground"
                    : standing?.unread
                      ? "text-foreground hover:bg-accent/60"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <span className={cn("min-w-0 flex-1 truncate", standing?.unread && "font-medium")}>{session.title}</span>
                {standing?.unread && (
                  <span aria-label="New reply" title="A reply you haven't seen" className="size-1.5 shrink-0 rounded-full bg-sky-400" />
                )}
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
                <RowTail at={session.at} now={now} hideOnHover={hasMenu} />
              </Link>
              <SessionMenu
                session={session}
                markable={!group.local}
                standing={standing}
                onDelete={onDelete}
                onArchive={onArchive}
                className="absolute right-1 top-1/2 -translate-y-1/2"
              />
            </div>
          );
        })}
      </div>
    </div>
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
  active,
}: {
  href: string;
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  /** Its keyboard shortcut, shown at the row's end on hover. */
  hint?: string;
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
      {hint && <Kbd>{hint}</Kbd>}
    </Link>
  );
}

function HeaderActionLink({
  href,
  label,
  count,
  countDescription,
  shortcut,
  icon,
  active,
}: {
  href: string;
  label: string;
  count: number;
  countDescription: string;
  shortcut?: string;
  icon: React.ReactNode;
  active: boolean;
}) {
  const spokenCount = count > 0 ? `, ${count} ${countDescription}` : "";
  return (
    <Link
      href={href}
      aria-label={`${label}${spokenCount}`}
      aria-keyshortcuts={shortcut ? keyShortcut(shortcut) : undefined}
      aria-current={active ? "page" : undefined}
      title={`${label}${count > 0 ? ` (${count} ${countDescription})` : ""}${shortcut ? ` · ${shortcut}` : ""}`}
      className={cn(
        "relative grid size-6 shrink-0 place-items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-4",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {icon}
      {count > 0 && (
        <span
          aria-hidden="true"
          className="absolute -right-1 -top-1 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] leading-none text-primary-foreground shadow-sm"
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}

/** A shortcut, shown only while its row is hovered or focused. */
function Kbd({ children }: { children: string }) {
  return (
    <kbd
      className="font-sans text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover/nav:opacity-100 group-focus-visible/nav:opacity-100"
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

/** The list's heading, as a choice: sessions by where they stand, or by
 *  project. */
function GroupingSwitch({ value, onChange }: { value: Grouping; onChange: (value: Grouping) => void }) {
  const option = (choice: Grouping, label: string) => (
    <button
      type="button"
      onClick={() => onChange(choice)}
      aria-pressed={value === choice}
      className={cn(
        "rounded px-1 text-[13px] transition-colors",
        value === choice ? "text-foreground" : "text-muted-foreground/70 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="List sessions by" className="-ml-1 flex items-center gap-0.5">
      {option("status", "Status")}
      <span aria-hidden className="text-[13px] text-muted-foreground/40">/</span>
      {option("projects", "Projects")}
    </div>
  );
}
