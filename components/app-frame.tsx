"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { PanelLeftOpen, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AppDataProvider } from "@/components/app-data";
import { AppSidebar } from "@/components/app-sidebar";
import { useServerAnswer } from "@/components/server-answer";
import { SIDEBAR_COOKIE } from "@/lib/nav/sidebar";
import { startNewSession } from "@/lib/session/new-session-reset";
import type { AppData } from "@/lib/session/session-view";
import { cn } from "@/lib/utils";

/** What the layout reads for the frame, streamed in (app/(app)/layout.tsx). */
export type FrameData = {
  appData: AppData;
  ownerLogin: string;
  ownerAvatarUrl: string | null;
  /** The sidebar collapsed, from its cookie. */
  collapsed: boolean;
  /** The projects folded shut in the sidebar, from their cookie. */
  folded: string[];
};

/** Where the choice was kept before the cookie, read once to carry it over. */
const LEGACY_KEYS = ["sidebar-collapsed", "home-sidebar-collapsed"];

/**
 * Sidebar + page. Collapsing leaves a narrow rail (expand, new session) rather
 * than nothing, so no page has to make room for a floating button. Below the
 * `sm` breakpoint the sidebar is hidden, as the pages were built for.
 *
 * The frame and the page show at once, even on a cold start; what the sidebar
 * lists (`server`, answering {@link FrameData}) streams in, its rows held by a
 * skeleton until then, and the pages render from it as it lands.
 */
export function AppFrame({ server, children }: { server: React.ReactNode; children: React.ReactNode }) {
  const [frame, slot] = useServerAnswer<FrameData>(server);
  // The collapse the user toggled here; else the cookie's, once read.
  const [collapsedChoice, setCollapsed] = useState<boolean | null>(null);
  const collapsed = collapsedChoice ?? frame?.collapsed ?? false;
  // The pages render from what the sidebar has: a click shows its session at once.
  const appData = frame?.appData ?? null;
  const sidebarProjects = useMemo(
    () => (appData ? [...appData.projects, ...appData.hiddenProjects] : []),
    [appData],
  );
  const router = useRouter();
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
    <div
      className={cn(
        "grid h-dvh grid-cols-1 overflow-hidden bg-background",
        collapsed ? "sm:grid-cols-[48px_minmax(0,1fr)]" : "sm:grid-cols-[264px_minmax(0,1fr)]",
      )}
    >
      <div className="hidden min-h-0 sm:block">
        {collapsed ? (
          <div className="flex h-full flex-col items-center gap-2 border-r border-border/60 bg-sidebar pt-5">
            <button
              type="button"
              onClick={() => setAndRemember(false)}
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
        ) : (
          <AppSidebar
            loading={frame === null}
            projects={sidebarProjects}
            workspaces={appData?.workspaces ?? NO_WORKSPACES}
            ownerLogin={frame?.ownerLogin ?? ""}
            ownerAvatarUrl={frame?.ownerAvatarUrl ?? null}
            onCollapse={() => setAndRemember(true)}
            searchSignal={searchSignal}
            initialFolded={frame?.folded ?? NO_FOLDED}
          />
        )}
      </div>
      <main className="relative min-h-0 min-w-0 overflow-y-auto">
        <AppDataProvider value={appData}>{children}</AppDataProvider>
      </main>
      {slot}
    </div>
  );
}

const NO_WORKSPACES: AppData["workspaces"] = [];
const NO_FOLDED: string[] = [];
