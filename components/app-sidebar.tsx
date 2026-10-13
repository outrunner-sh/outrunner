"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Ellipsis,
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

import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import { HomeUserMenu } from "@/components/home-user-menu";
import { OutrunnerAllowance } from "@/components/outrunner-allowance";
import { Spinner } from "@/components/ui/loaders";
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
  type SessionDeletion,
  type SidebarGroup,
} from "@/lib/nav/sidebar";
import type { NavProject } from "@/lib/nav/workspace-nav-groups";
import type { Workspace } from "@/lib/runtime/types";
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
  ownerLogin,
  ownerAvatarUrl,
  onCollapse,
  searchSignal = 0,
}: {
  projects: NavProject[];
  workspaces: Workspace[];
  ownerLogin: string;
  ownerAvatarUrl: string | null;
  onCollapse: () => void;
  /** Changes each time ⌘K is pressed: open the search field. */
  searchSignal?: number;
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
    () => buildSidebarGroups(projects, workspaces, local.sessions),
    [projects, workspaces, local.sessions],
  );
  const shown = filterSidebarGroups(groups, query);

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

      <nav className="space-y-0.5" aria-label="Main">
        {/* Home is the new-session screen too. */}
        <NavLink
          href="/new"
          icon={<Plus />}
          label="New Session"
          hint="⌘N"
          active={pathname === "/" || pathname === "/new"}
        />
        <NavSoon icon={<Flag />} label="Runner" />
        <NavSoon icon={<Sparkles />} label="Automations" />
        {searching ? (
          <SearchField value={query} onChange={setQuery} onClose={closeSearch} />
        ) : (
          <NavButton icon={<Search />} label="Search" hint="⌘K" onClick={() => setSearching(true)} />
        )}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-center justify-between px-2">
          <h2 className="text-sm text-muted-foreground">Projects</h2>
          {/* Opens the new-session screen, where any repository or folder can be
              picked: the way to start in a project not listed yet. */}
          <Link
            href="/new"
            aria-label="Start a session in another project"
            title="Start a session in another project"
            className="-mr-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderPlus className="size-4" />
          </Link>
        </div>
        {/* This Mac's sessions are read from the agent after the page loads, so
            the list waits for them rather than reshuffling as they land. */}
        <SkeletonSwap ready={local.state !== "loading"} skeleton={<SidebarSkeleton />} label="Sessions" className="mt-2">
          <div className="space-y-3">
            {shown.length === 0 ? (
              <p className="px-2 py-1 text-sm text-muted-foreground">
                {query ? "No matching sessions" : "No sessions yet"}
              </p>
            ) : (
              shown.map((group) => (
                <WorkspaceGroup key={group.key} group={group} active={active} now={now} onDelete={setDeleting} />
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

      <OutrunnerAllowance />
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
  onDelete,
}: {
  group: SidebarGroup;
  active?: string;
  now: number;
  /** Opens the delete confirmation for one of its sessions. */
  onDelete: (session: DeletingSession) => void;
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
        const { deletion } = session;
        return (
          <div key={session.id} className="group/row relative">
            <Link
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
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
              <RowTail at={session.at} now={now} hideOnHover={deletion !== null} />
            </Link>
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

/** Two groups of placeholder rows, at the real rows' height (32px): a project
 *  header, then its sessions indented to where their titles start. */
function SidebarSkeleton() {
  return (
    <div className="space-y-3">
      {[3, 2].map((sessions, i) => (
        <div key={i}>
          <SkeletonRows rows={1} rowHeight={32} indent={34} />
          <SkeletonRows rows={sessions} rowHeight={32} indent={34} />
        </div>
      ))}
    </div>
  );
}

type DeletingSession = { id: string; title: string; deletion: SessionDeletion };

const rowClass =
  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0";

function NavLink({
  href,
  icon,
  label,
  hint,
  active,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  /** Its keyboard shortcut, shown at the row's end on hover. */
  hint?: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      aria-keyshortcuts={hint ? keyShortcut(hint) : undefined}
      className={cn(
        rowClass,
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
      className={cn(rowClass, "group/nav text-muted-foreground hover:bg-accent hover:text-foreground")}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {hint && <Kbd>{hint}</Kbd>}
    </button>
  );
}

/** A shortcut, shown only while its row is hovered or focused. */
function Kbd({ children }: { children: string }) {
  return (
    <kbd className="font-sans text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover/nav:opacity-100 group-focus-visible/nav:opacity-100">
      {children}
    </kbd>
  );
}

/** "⌘K" as aria-keyshortcuts spells it. */
function keyShortcut(hint: string): string {
  return hint.replace("⌘", "Meta+");
}

/** A destination that does not exist yet: shown dimmed, not clickable; its
 *  tooltip says it is coming. */
function NavSoon({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div
      aria-disabled="true"
      title={`${label} is coming soon`}
      className={cn(rowClass, "cursor-default text-muted-foreground/60")}
    >
      {icon}
      {label}
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
