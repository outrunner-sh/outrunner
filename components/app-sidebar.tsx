"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Flag,
  Folder,
  FolderPlus,
  Laptop,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { HomeUserMenu } from "@/components/home-user-menu";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { useLocalSessions } from "@/hooks/use-local-sessions";
import { useNow } from "@/hooks/use-now";
import { startNextSessionIn, startNextSessionInCloud } from "@/hooks/use-session-location";
import {
  activeSessionId,
  buildSidebarGroups,
  filterSidebarGroups,
  newSessionHref,
  relativeTime,
  type SidebarGroup,
  type SidebarPerson,
} from "@/lib/nav/sidebar";
import type { NavProject } from "@/lib/nav/workspace-nav-groups";
import type { Workspace } from "@/lib/runtime/types";
import { runsSessions, type Team } from "@/lib/teams/roles";
import { cn } from "@/lib/utils";

/**
 * The one sidebar every app page shares (rendered by app/(app)/layout.tsx, so
 * it stays put while you move between sessions): the primary actions, then
 * every workspace with its sessions nested underneath (cloud repositories and
 * this Mac's folders together, newest activity first), then the user.
 */
export function AppSidebar({
  projects,
  workspaces,
  ownerId,
  ownerLogin,
  ownerAvatarUrl,
  team,
  teams,
  people,
  onCollapse,
}: {
  projects: NavProject[];
  workspaces: Workspace[];
  ownerId: string;
  ownerLogin: string;
  ownerAvatarUrl: string | null;
  /** The workspace shown, and every one the user is in, for the switcher. */
  team: Team | null;
  teams: Team[];
  /** The workspace's members by user id: who started a teammate's session. */
  people: Record<string, SidebarPerson>;
  onCollapse: () => void;
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

  const canStart = team ? runsSessions(team.role) : true;
  const groups = useMemo(
    () => buildSidebarGroups(projects, workspaces, local.sessions, { userId: ownerId, people, canStart }),
    [projects, workspaces, local.sessions, ownerId, people, canStart],
  );
  const shown = filterSidebarGroups(groups, query);

  const closeSearch = () => {
    setQuery("");
    setSearching(false);
  };

  return (
    <aside className="flex h-full min-h-0 flex-col gap-5 border-r border-border/60 px-3 pb-3 pt-5">
      <div className="flex items-center justify-between px-2">
        <Link href="/" className="flex items-center gap-2 font-mono text-sm font-semibold text-foreground">
          <Terminal className="size-4" />
          outrunner
        </Link>
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

      {team && <WorkspaceSwitcher team={team} teams={teams} />}

      <nav className="space-y-0.5" aria-label="Main">
        <NavLink href="/new" icon={<Plus />} label="New Session" active={pathname === "/new"} />
        <NavSoon icon={<Flag />} label="Runner" />
        <NavSoon icon={<Sparkles />} label="Automations" />
        {searching ? (
          <SearchField value={query} onChange={setQuery} onClose={closeSearch} />
        ) : (
          <NavButton icon={<Search />} label="Search" onClick={() => setSearching(true)} />
        )}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-center justify-between px-2">
          <h2 className="text-sm text-muted-foreground">Projects</h2>
          <Link
            href="/new"
            aria-label="New session"
            title="New session"
            className="-mr-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderPlus className="size-4" />
          </Link>
        </div>
        <div className="mt-2 space-y-3">
          {shown.length === 0 ? (
            <p className="px-2 py-1 text-sm text-muted-foreground">
              {query ? "No matching sessions" : "No sessions yet"}
            </p>
          ) : (
            shown.map((group) => (
              <WorkspaceGroup key={group.key} group={group} active={active} now={now} />
            ))
          )}
        </div>
      </div>

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

/** A workspace and its sessions. The `+` starts a new session in it, where
 *  there is a repository (or folder) to start one in. */
function WorkspaceGroup({
  group,
  active,
  now,
}: {
  group: SidebarGroup;
  active?: string;
  now: number;
}) {
  const router = useRouter();
  const { start } = group;
  // Set the form's cloud/Mac choice, then open a fresh form for this target
  // (newSessionHref: a new key each click, even for the URL already open).
  const startHere = () => {
    if (!start) return;
    if (start.kind === "local") startNextSessionIn(start.folder);
    else startNextSessionInCloud();
    router.push(newSessionHref(start, Date.now().toString(36)));
  };
  const Icon = group.local ? Laptop : Folder;
  return (
    <div>
      <div className="group/ws flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-foreground">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate" title={group.local ? `${group.detail} · this Mac` : group.detail}>
          {group.label}
        </span>
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
      {group.sessions.map((session) => {
        const isActive = session.id === active;
        return (
          <Link
            key={session.id}
            href={session.href}
            title={session.title}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md py-1.5 pl-[34px] pr-2 text-sm transition-colors",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {session.by && <Starter person={session.by} />}
            <span className="min-w-0 flex-1 truncate">{session.title}</span>
            {/* The server's clock and the browser's differ by the render
                delay, which can tip "59m" into "1h": not a real mismatch. */}
            <time
              dateTime={session.at}
              suppressHydrationWarning
              className="shrink-0 text-xs text-muted-foreground"
            >
              {relativeTime(session.at, now)}
            </time>
          </Link>
        );
      })}
    </div>
  );
}

/** Who started a teammate's session: their avatar, their login on hover. */
function Starter({ person }: { person: SidebarPerson }) {
  const who = person.login ? `Started by @${person.login}` : "Started by a teammate";
  return person.avatarUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- a GitHub avatar, sized by CSS
    <img src={person.avatarUrl} alt={who} title={who} className="-ml-[22px] size-4 shrink-0 rounded-full" />
  ) : (
    <span
      title={who}
      aria-label={who}
      className="-ml-[22px] grid size-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] uppercase text-foreground"
    >
      {person.login?.slice(0, 1) ?? "?"}
    </span>
  );
}

const rowClass =
  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0";

function NavLink({
  href,
  icon,
  label,
  active,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        rowClass,
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </Link>
  );
}

function NavButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(rowClass, "text-muted-foreground hover:bg-accent hover:text-foreground")}
    >
      {icon}
      {label}
    </button>
  );
}

/** A destination that does not exist yet: shown, labelled, not clickable. */
function NavSoon({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div aria-disabled="true" className={cn(rowClass, "cursor-default text-muted-foreground/60")}>
      {icon}
      <span className="flex-1">{label}</span>
      <span className="rounded border border-border/60 px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
        Soon
      </span>
    </div>
  );
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
    <div className={cn(rowClass, "bg-accent/60 text-foreground")}>
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
