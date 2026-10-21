"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeftOpen, Plus } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { AppDataProvider } from "@/components/app-data";
import { AppSidebar } from "@/components/app-sidebar";
import { isStudioPath, SIDEBAR_COOKIE } from "@/lib/nav/sidebar";
import { startNewSession } from "@/lib/session/new-session-reset";
import type { Project, Workspace, WorkspacePullRequest } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

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
 */
export function AppFrame({
  projects,
  hiddenProjects,
  workspaces,
  pullRequests,
  ownerLogin,
  ownerAvatarUrl,
  initialCollapsed = false,
  initialFolded = [],
  children,
}: {
  /** The repositories listed to start sessions in. */
  projects: Project[];
  /** Hidden ones a session belongs to, for naming it. */
  hiddenProjects: Project[];
  workspaces: Workspace[];
  /** Each session's pull request, by workspace id. */
  pullRequests: Record<string, WorkspacePullRequest>;
  ownerLogin: string;
  ownerAvatarUrl: string | null;
  /** From the cookie, read by the layout on the server. */
  initialCollapsed?: boolean;
  /** The projects folded shut in the sidebar, from their cookie. */
  initialFolded?: string[];
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  // The pages render from what the sidebar has: a click shows its session at once.
  const appData = useMemo(
    () => ({ projects, hiddenProjects, workspaces, pullRequests }),
    [projects, hiddenProjects, workspaces, pullRequests],
  );
  const sidebarProjects = useMemo(() => [...projects, ...hiddenProjects], [projects, hiddenProjects]);
  const router = useRouter();
  const pathname = usePathname();
  // Decided by the path, not by the studio being on screen: the rail must not
  // flash in while one session's page loads in place of another's.
  const railless = collapsed && isStudioPath(pathname);
  // Bumped by ⌘K: the sidebar opens its search field on each change.
  const [searchSignal, setSearchSignal] = useState(0);

  const setAndRemember = (next: boolean) => {
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  };

  // App-wide shortcuts: ⌘N a new session, ⌘K search the sidebar (opening it
  // if collapsed). With a modifier they are safe even while typing. (A browser
  // keeps ⌘N for itself; the Mac app passes it through.)
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
        setCollapsed(false);
        setSearchSignal((n) => n + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

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
              : "sm:grid-cols-[264px_minmax(0,1fr)]",
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
                projects={sidebarProjects}
                workspaces={workspaces}
                ownerLogin={ownerLogin}
                ownerAvatarUrl={ownerAvatarUrl}
                onCollapse={() => setAndRemember(true)}
                searchSignal={searchSignal}
                initialFolded={initialFolded}
              />
            )}
          </div>
        )}
        <main className="relative min-h-0 min-w-0 overflow-y-auto">
          <AppDataProvider value={appData}>{children}</AppDataProvider>
        </main>
      </div>
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
