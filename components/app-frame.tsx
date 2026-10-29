"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeftOpen, Plus } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

import { AppDataProvider } from "@/components/app-data";
import { AppSidebar } from "@/components/app-sidebar";
import { MissionToasts } from "@/components/missions/mission-toasts";
import { useServerAnswer } from "@/components/server-answer";
import { useNotificationsFeed } from "@/hooks/use-notifications";
import { standingsNow, useStandingsFeed } from "@/hooks/use-standings";
import { activeSessionId, isStudioPath, SIDEBAR_COOKIE } from "@/lib/nav/sidebar";
import type { Grouping } from "@/lib/nav/status-groups";
import { cachedListFor, rememberAppData, useCachedAppData } from "@/lib/session/app-data-cache";
import { nextNeedingYou } from "@/lib/session/standing";
import { startNewSession } from "@/lib/session/new-session-reset";
import type { Org } from "@/lib/orgs/active";
import type { AppData } from "@/lib/session/session-view";
import { warmSession } from "@/lib/session/warm-session";
import { captureHref } from "@/lib/triage/work-items";
import { cn } from "@/lib/utils";

/** What the layout reads for the frame, streamed in (app/(app)/layout.tsx). */
export type FrameData = {
  appData: AppData;
  ownerLogin: string;
  ownerAvatarUrl: string | null;
  /** The user's orgs, personal first, for the switcher; empty before orgs. */
  orgs: Org[];
  /** The org the sidebar lists (lib/orgs/active.ts). */
  activeOrgId: string | null;
  /** Work items waiting in triage: the sidebar's count. */
  triageCount: number;
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
 *  a page that shows no header must put the buttons up itself. */
const CollapsedSidebar = createContext<{
  collapsed: boolean;
  railless: boolean;
  expand: () => void;
} | null>(null);

/**
 * Sidebar + page. Collapsing leaves a narrow rail (expand, new session) rather
 * than nothing, so no page has to make room for a floating button. A session's
 * page has a header of its own that shows those buttons instead
 * (CollapsedSidebarButtons), so there the rail steps aside and the session
 * runs edge to edge. Below the `sm` breakpoint the sidebar is hidden, as the
 * pages were built for.
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
  const appData: AppData | null = frame?.appData ?? cachedListFor(cached, look?.pickedOrgId);
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
  const router = useRouter();
  const pathname = usePathname();
  // Decided by the path, not by the studio being on screen: the rail must not
  // flash in while one session's page loads in place of another's.
  const railless = collapsed && isStudioPath(pathname);
  // The sidebar shows the kept list at once too — except where a list landing
  // late would move the rows on screen. Grouped by status it would: the
  // server's standings are what place each session in its group
  // (lib/nav/status-groups.ts), and the kept list doesn't carry them. Grouped
  // by project the rows are the projects', which the kept list does carry.
  const sidebarFromCache = appData !== null && (look?.grouping ?? "status") === "projects";
  // Bumped by ⌘K: the sidebar opens its search field on each change.
  const [searchSignal, setSearchSignal] = useState(0);

  // Where each session stands, kept live for the sidebar and the sessions
  // list; the cloud session on screen is marked seen as its replies come.
  const onScreen = pathname.startsWith("/workspaces/") ? activeSessionId(pathname) : undefined;
  const cloudIds = useMemo(() => (appData?.workspaces ?? NO_WORKSPACES).map((w) => w.id), [appData]);
  useStandingsFeed({
    initial: appData?.standings,
    // Not before the layout's list is in: an empty page isn't a list to compare.
    ids: cloudIds,
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
    <CollapsedSidebar.Provider value={{ collapsed, railless, expand: () => setAndRemember(false) }}>
      <div
        className={cn(
          "grid h-dvh grid-cols-1 overflow-hidden bg-background",
          railless
            ? "sm:grid-cols-1"
            : collapsed
              ? "sm:grid-cols-[48px_minmax(0,1fr)]"
              : "sm:grid-cols-[320px_minmax(0,1fr)]",
        )}
      >
        {!railless && (
          <div className="hidden min-h-0 sm:block">
            {collapsed ? (
              <div className="h-full border-r border-border/60 bg-sidebar pt-5">
                <CollapsedSidebarButtons className="flex flex-col items-center gap-2" />
              </div>
            ) : (
              <AppSidebar
                loading={frame === null && !sidebarFromCache}
                projects={sidebarProjects}
                workspaces={appData?.workspaces ?? NO_WORKSPACES}
                ownerLogin={frame?.ownerLogin ?? ""}
                ownerAvatarUrl={frame?.ownerAvatarUrl ?? null}
                orgs={frame?.orgs ?? NO_ORGS}
                activeOrgId={frame?.activeOrgId ?? null}
                triageCount={frame?.triageCount ?? 0}
                onCollapse={() => setAndRemember(true)}
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
        <main className="relative min-h-0 min-w-0 overflow-y-auto">
          <AppDataProvider value={appData}>{children}</AppDataProvider>
        </main>
      </div>
      {chromeSlot}
      {slot}
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
  if (!sidebar?.railless) return null;
  return (
    <SidebarButtons
      className="absolute top-2.5 left-3 z-10 flex items-center gap-0.5"
      expand={sidebar.expand}
    />
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
