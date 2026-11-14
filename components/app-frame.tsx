"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Menu, PanelLeftOpen, Plus } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

import { AppDataProvider, ViewerScopeProvider } from "@/components/app-data";
import { SessionDeletionDialog } from "@/components/delete-session-dialog";
import { AppSidebar } from "@/components/app-sidebar";
import { GitHubConnectionNoticeBanner } from "@/components/github-connection-notice";
import { ArchiveNotice, ArchiveUndoToast } from "@/components/archive-session-dialog";
import { MissionToasts } from "@/components/missions/mission-toasts";
import { useServerAnswer } from "@/components/server-answer";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useModalPanel } from "@/hooks/use-modal-panel";
import { useNotificationsFeed } from "@/hooks/use-notifications";
import { standingsNow, useStandingsFeed } from "@/hooks/use-standings";
import type { GitHubConnectionNotice } from "@/lib/github/connection-notice";
import { activeSessionId, isStudioPath, SIDEBAR_COOKIE } from "@/lib/nav/sidebar";
import type { Grouping } from "@/lib/nav/status-groups";
import { cachedListFor, rememberAppData, useCachedAppData } from "@/lib/session/app-data-cache";
import { usePendingSessions } from "@/lib/session/pending-sessions";
import { useAppDataAhead } from "@/lib/session/rows-ahead";
import { nextNeedingYou } from "@/lib/session/standing";
import { startNewSession } from "@/lib/session/new-session-reset";
import { type Org, viewerScope } from "@/lib/orgs/active";
import type { AppData } from "@/lib/session/session-view";
import { warmSession } from "@/lib/session/warm-session";
import { forgetTriageCountAhead, useTriageCountAhead } from "@/lib/triage/kept-triage";
import { captureHref } from "@/lib/triage/work-items";
import { cn } from "@/lib/utils";

/** What the layout reads for the frame, streamed in (app/(app)/layout.tsx). */
export type FrameData = {
  appData: AppData;
  /** The signed-in user's id. */
  ownerId: string;
  ownerLogin: string;
  ownerAvatarUrl: string | null;
  /** The user's orgs, personal first, for the switcher; empty before orgs. */
  orgs: Org[];
  /** The org the sidebar lists (lib/orgs/active.ts). */
  activeOrgId: string | null;
  /** Work items waiting in triage: the sidebar's count. */
  triageCount: number;
  /** Whether to ask them to connect GitHub (lib/github/connection-notice.ts). */
  githubNotice?: GitHubConnectionNotice;
};

/**
 * How the sidebar was left, from cookies alone — so it arrives ahead of
 * {@link FrameData}, whose queries would otherwise hold the collapse back
 * until after the first paint (app/(app)/layout.tsx).
 */
export type FrameChrome = {
  /** The sidebar collapsed, from its cookie. */
  collapsed: boolean;
  /** The projects folded shut in the sidebar, from their cookie. */
  folded: string[];
  /** The "Get started" checklist skipped, from its cookie. */
  getStartedSkipped: boolean;
  /** How the sidebar lists sessions, by status or by project, from its cookie. */
  grouping: Grouping;
  /** The org the switcher last set (its cookie), or null before any switch:
   *  which org's list the cache may stand in for
   *  (lib/session/app-data-cache.ts). */
  pickedOrgId: string | null;
};

/** Where the choice was kept before the cookie, read once to carry it over. */
const LEGACY_KEYS = ["sidebar-collapsed", "home-sidebar-collapsed"];

/** The collapsed sidebar, for whichever header shows its buttons. `railless`
 *  is the stronger case: the rail has stepped aside for a session's header, so
 *  a page that shows no header must put the buttons up itself. On a phone the
 *  sidebar is a drawer: `studio` pages put its menu button in their own
 *  header, where the frame's bar would take a second row. */
const CollapsedSidebar = createContext<{
  collapsed: boolean;
  railless: boolean;
  expand: () => void;
  studio: boolean;
  drawerOpen: boolean;
  openDrawer: () => void;
} | null>(null);

/**
 * Sidebar + page. Collapsing leaves a narrow rail (expand, new session) rather
 * than nothing, so no page has to make room for a floating button. A session's
 * page has a header of its own that shows those buttons instead
 * (CollapsedSidebarButtons), so there the rail steps aside and the session
 * runs edge to edge. Below the `sm` breakpoint the sidebar is a drawer instead,
 * opened from a menu button: in a bar across the top, or in a session's own
 * header (MobileNavButton). It closes on Esc, on a tap outside it, and as a
 * link in it is followed.
 *
 * The frame and the page show at once, even on a cold start; what the sidebar
 * lists (`server`, answering {@link FrameData}) streams in, its rows held by a
 * skeleton until then, and the pages render from it as it lands. How the
 * sidebar was left (`chrome`, answering {@link FrameChrome}) is read from
 * cookies alone, so the collapse lands first and the sidebar never opens wide
 * and snaps shut.
 */
export function AppFrame({
  chrome,
  server,
  children,
}: {
  chrome: React.ReactNode;
  server: React.ReactNode;
  children: React.ReactNode;
}) {
  const [frame, slot] = useServerAnswer<FrameData>(server);
  const [look, chromeSlot] = useServerAnswer<FrameChrome>(chrome);
  // The collapse the user toggled here; else the cookie's, once read.
  const [collapsedChoice, setCollapsed] = useState<boolean | null>(null);
  const collapsed = collapsedChoice ?? look?.collapsed ?? false;
  // The pages render from what the sidebar has: a click shows its session at
  // once. Until the server's list lands, that is the list kept from the last
  // time the user was here (lib/session/app-data-cache.ts): a reload, a deep
  // link or the app's relaunch shows its session rather than a placeholder.
  // The server's own list always wins over it.
  const cached = useCachedAppData();
  // With what this tab has changed since it was read laid over it
  // (lib/session/rows-ahead.ts): a session archived or named here shows so at
  // once, without reading the list again.
  const appData: AppData | null = useAppDataAhead(frame?.appData ?? cachedListFor(cached, look?.pickedOrgId));
  // Sessions this tab has just started, listed from the moment Send is
  // pressed until the server's list has them (lib/session/pending-sessions.ts);
  // one the server refused goes again.
  const pending = usePendingSessions();
  const sidebarWorkspaces = useMemo(() => {
    const listed = appData?.workspaces ?? NO_WORKSPACES;
    const started = Object.values(pending)
      .filter((p) => !p.refused && !listed.some((w) => w.id === p.workspace.id))
      .map((p) => p.workspace);
    return started.length > 0 ? [...started, ...listed] : listed;
  }, [appData, pending]);
  const sidebarProjects = useMemo(
    () => (appData ? [...appData.projects, ...appData.hiddenProjects] : []),
    [appData],
  );
  // Keep what the layout sent, for the next cold start. Only the server's own
  // list is kept: nothing derived here, and nothing about where sessions stand.
  // Whose it is comes from the chrome's cookie, the same signal a later page
  // compares it against (lib/session/app-data-cache.ts).
  useEffect(() => {
    if (frame) rememberAppData(look?.pickedOrgId ?? null, frame.appData);
  }, [frame, look?.pickedOrgId]);
  // Triage's count as its page last read it, until the layout reads its own.
  const triageCountAhead = useTriageCountAhead();
  useEffect(() => {
    forgetTriageCountAhead();
  }, [frame]);
  const router = useRouter();
  const pathname = usePathname();
  // Decided by the path, not by the studio being on screen: the rail must not
  // flash in while one session's page loads in place of another's.
  const studio = isStudioPath(pathname);
  const railless = collapsed && studio;
  // The phone's drawer, open on the page it was opened on: a navigation, a
  // link's or ⌘J's, closes it. It is a drawer below `sm` only.
  const wide = useMediaQuery("(min-width: 640px)");
  const [drawerOn, setDrawerOn] = useState<string | null>(null);
  const drawerOpen = drawerOn === pathname && !wide;
  // Closed for good once it stops matching: Back to the page it was opened
  // on, or a window narrow again, must not open it by itself.
  if (drawerOn !== null && !drawerOpen) setDrawerOn(null);
  const closeDrawer = () => setDrawerOn(null);
  const drawer = useModalPanel(drawerOpen, closeDrawer);
  // The sidebar shows the kept list at once too — grouped by project, and
  // grouped by status when the kept list carries where its sessions stood:
  // the standings place each session in its group (lib/nav/status-groups.ts),
  // and the server's, landing within moments, move only those that moved.
  const sidebarFromCache = appData !== null && ((look?.grouping ?? "status") === "projects" || appData.standings !== undefined);
  // Bumped by ⌘K: the sidebar opens its search field on each change.
  const [searchSignal, setSearchSignal] = useState(0);

  // Where each session stands, kept live for the sidebar and the sessions
  // list; the cloud session on screen is marked seen as its replies come.
  const onScreen = pathname.startsWith("/workspaces/") ? activeSessionId(pathname) : undefined;
  const cloudIds = useMemo(() => (appData?.workspaces ?? NO_WORKSPACES).map((w) => w.id), [appData]);
  const cloudBranches = useMemo(
    () => Object.fromEntries((appData?.workspaces ?? NO_WORKSPACES).map((w) => [w.id, w.branch])),
    [appData],
  );
  useStandingsFeed({
    initial: appData?.standings,
    // Not before the layout's list is in: an empty page isn't a list to compare.
    ids: cloudIds,
    branches: cloudBranches,
    onScreen,
    onListChanged: () => {
      // The server's own list, not the one kept from last time: the marks and
      // the standings are read against it.
      if (frame) router.refresh();
    },
  });
  // Turns finished, questions, errors and pull requests, shown as they come
  // (not for the session on screen).
  useNotificationsFeed({ onScreen, open: (id) => router.push(`/workspaces/${id}`) });
  const here = useRef(onScreen);
  useEffect(() => {
    here.current = onScreen;
  });

  const setAndRemember = (next: boolean) => {
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  };

  // App-wide shortcuts: ⌘N a new session, ⌘K search the sidebar (opening it
  // if collapsed), ⌘I capture a triage item, ⌘J the next session that needs
  // you. With a modifier they are safe even while typing. (A browser keeps ⌘N
  // for itself; the Mac app passes it through.)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        startNewSession();
        router.push("/new");
      } else if (key === "k") {
        event.preventDefault();
        setAndRemember(false);
        setSearchSignal((n) => n + 1);
      } else if (key === "i") {
        event.preventDefault();
        // On the triage page the dialog opens over the item already there,
        // and in the workspace it was started in, as the page's own buttons
        // do (components/triage/triage-view.tsx).
        const params = pathname === "/triage" ? new URLSearchParams(window.location.search) : null;
        router.push(captureHref({ item: params?.get("item"), project: params?.get("project") }), { scroll: false });
      } else if (key === "j") {
        event.preventDefault();
        const standings = standingsNow();
        const next = nextNeedingYou(
          Object.entries(standings).map(([id, standing]) => ({ id, ...standing })),
          here.current,
        );
        if (next) {
          // Warmed like a sidebar row the pointer rests on
          // (lib/session/warm-session.ts): the jump lands on a session already
          // attaching. No row was hovered — the shortcut went straight there.
          warmSession(next);
          router.push(`/workspaces/${next}`);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pathname, router]);

  // Carry a choice saved before the cookie existed over to it, once.
  useEffect(() => {
    if (document.cookie.split("; ").some((c) => c.startsWith(`${SIDEBAR_COOKIE}=`))) return;
    let stored: string | null = null;
    try {
      stored = LEGACY_KEYS.map((key) => window.localStorage.getItem(key)).find((v) => v !== null) ?? null;
    } catch {
      // Storage disabled: nothing to carry over.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored === "1") setAndRemember(true);
  }, []);

  return (
    <CollapsedSidebar.Provider
      value={{
        collapsed,
        railless,
        expand: () => setAndRemember(false),
        studio,
        drawerOpen,
        openDrawer: () => setDrawerOn(pathname),
      }}
    >
      <div
        className={cn(
          "grid h-dvh grid-cols-1 overflow-hidden bg-background [--app-sidebar-width:320px]",
          !studio && "max-sm:grid-rows-[auto_minmax(0,1fr)]",
          railless
            ? "sm:grid-cols-1"
            : collapsed
              ? "sm:grid-cols-[48px_minmax(0,1fr)]"
              : "sm:grid-cols-[var(--app-sidebar-width)_minmax(0,1fr)]",
        )}
      >
        {drawerOpen && <div aria-hidden className="fixed inset-0 z-40 bg-black/60 sm:hidden" onClick={closeDrawer} />}
        {(!railless || drawerOpen) && (
          <div
            id="app-sidebar"
            ref={drawer}
            role={drawerOpen ? "dialog" : undefined}
            aria-modal={drawerOpen || undefined}
            aria-label={drawerOpen ? "Navigation" : undefined}
            // A link followed closes the drawer, even to the page already open.
            onClickCapture={(event) => {
              if (drawerOpen && (event.target as Element).closest("a[href]")) closeDrawer();
            }}
            className={cn(
              "min-h-0 sm:block",
              drawerOpen
                ? "fixed inset-y-0 left-0 z-50 w-[min(var(--app-sidebar-width),85vw)] shadow-2xl shadow-black/60 sm:static sm:w-auto sm:shadow-none"
                : "hidden",
            )}
          >
            {collapsed && !drawerOpen ? (
              <div className="h-full border-r border-border/60 bg-sidebar pt-5">
                <CollapsedSidebarButtons className="flex flex-col items-center gap-2" />
              </div>
            ) : (
              <AppSidebar
                loading={frame === null && !sidebarFromCache}
                projects={sidebarProjects}
                workspaces={sidebarWorkspaces}
                pullRequests={appData?.pullRequests}
                ownerLogin={frame?.ownerLogin ?? ""}
                ownerAvatarUrl={frame?.ownerAvatarUrl ?? null}
                orgs={frame?.orgs ?? NO_ORGS}
                activeOrgId={frame?.activeOrgId ?? null}
                triageCount={triageCountAhead ?? frame?.triageCount ?? 0}
                // In the drawer, its collapse button closes the drawer.
                onCollapse={drawerOpen ? closeDrawer : () => setAndRemember(true)}
                collapseLabel={drawerOpen ? "Close menu" : undefined}
                searchSignal={searchSignal}
                initialFolded={look?.folded ?? NO_FOLDED}
                // Null until the cookies land: the checklist waits rather than
                // show itself to someone who skipped it.
                getStartedSkipped={look ? look.getStartedSkipped : null}
                initialGrouping={look?.grouping ?? "status"}
              />
            )}
          </div>
        )}
        {!studio && (
          <div className="flex h-11 items-center gap-1 border-b border-border/60 px-2 sm:hidden">
            <MobileNavButton />
            <Link href="/" aria-label="Home" className="px-1.5 text-sm font-medium text-foreground">
              Outrunner
            </Link>
            <Link
              href="/new"
              onClick={startNewSession}
              aria-label="New session"
              title="New session"
              className="ml-auto rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-4" />
            </Link>
          </div>
        )}
        <main className="relative min-h-0 min-w-0 overflow-y-auto">
          <AppDataProvider value={appData}>
            <ViewerScopeProvider value={frame?.activeOrgId ? viewerScope(frame.ownerId, frame.activeOrgId) : null}>
              {children}
            </ViewerScopeProvider>
          </AppDataProvider>
        </main>
      </div>
      {chromeSlot}
      {slot}
      <ArchiveNotice />
      <ArchiveUndoToast />
      <GitHubConnectionNoticeBanner notice={frame?.githubNotice ?? null} />
      <SessionDeletionDialog />
      {/* A Mission's news while the user looks, whatever the sidebar does
          (components/missions/mission-toasts.tsx). */}
      <MissionToasts />
    </CollapsedSidebar.Provider>
  );
}

/**
 * Expand and new session, while the sidebar is collapsed (nothing otherwise):
 * in the rail, or in a session's header where the rail steps aside. Hidden
 * below `sm`, where the sidebar is too.
 */
export function CollapsedSidebarButtons({ className }: { className?: string }) {
  const sidebar = useContext(CollapsedSidebar);
  if (!sidebar?.collapsed) return null;
  return <SidebarButtons className={className} expand={sidebar.expand} />;
}

/**
 * The same buttons for a session path's full-page states — opening, missing,
 * failed, or a local session this Mac doesn't have — which have no header of
 * their own. The rail has already stepped aside for the path, so without these
 * there would be no way back to the sidebar (route-states.tsx: there is always
 * a way on, and the Mac app has no browser back button).
 */
export function RaillessSidebarButtons() {
  const sidebar = useContext(CollapsedSidebar);
  if (!sidebar?.railless && !sidebar?.studio) return null;
  return (
    <div className="absolute top-2.5 left-3 z-10 flex items-center gap-0.5">
      {/* A session path has no frame bar on a phone: the drawer opens here,
          unless this state is inside the studio, whose header has it. */}
      {sidebar.studio && <MobileNavButton className="railless-menu" />}
      {sidebar.railless && <SidebarButtons className="flex items-center gap-0.5" expand={sidebar.expand} />}
    </div>
  );
}

/** Opens the sidebar's drawer, below `sm` only (above it the sidebar shows). */
export function MobileNavButton({ className }: { className?: string }) {
  const sidebar = useContext(CollapsedSidebar);
  if (!sidebar) return null;
  return (
    <button
      type="button"
      onClick={sidebar.openDrawer}
      aria-label="Open menu"
      title="Menu"
      aria-expanded={sidebar.drawerOpen}
      aria-controls="app-sidebar"
      className={cn(
        "shrink-0 rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:hidden",
        className,
      )}
    >
      <Menu className="size-4" />
    </button>
  );
}

function SidebarButtons({ className, expand }: { className?: string; expand: () => void }) {
  return (
    <div className={cn("max-sm:hidden", className)}>
      <button
        type="button"
        onClick={expand}
        aria-label="Expand sidebar"
        title="Expand sidebar"
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <PanelLeftOpen className="size-4" />
      </button>
      <Link
        href="/new"
        onClick={startNewSession}
        aria-label="New session"
        title="New session (⌘N)"
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Plus className="size-4" />
      </Link>
    </div>
  );
}

const NO_WORKSPACES: AppData["workspaces"] = [];
const NO_ORGS: Org[] = [];
const NO_FOLDED: string[] = [];
