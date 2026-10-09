"use client";

import Link from "next/link";
import { PanelLeftOpen, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import type { SidebarPerson } from "@/lib/nav/sidebar";
import type { NavProject } from "@/lib/nav/workspace-nav-groups";
import type { Workspace } from "@/lib/runtime/types";
import type { Team } from "@/lib/teams/roles";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "sidebar-collapsed";
/** What the home page's own sidebar used to remember it under. */
const LEGACY_COLLAPSE_KEY = "home-sidebar-collapsed";

/**
 * Sidebar + page. Collapsing leaves a narrow rail (expand, new session) rather
 * than nothing, so no page has to make room for a floating button. Below the
 * `sm` breakpoint the sidebar is hidden, as the pages were built for.
 */
export function AppFrame({
  projects,
  workspaces,
  ownerId,
  ownerLogin,
  ownerAvatarUrl,
  team,
  teams,
  people,
  children,
}: {
  projects: NavProject[];
  workspaces: Workspace[];
  ownerId: string;
  ownerLogin: string;
  ownerAvatarUrl: string | null;
  team: Team | null;
  teams: Team[];
  people: Record<string, SidebarPerson>;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // Restore after hydration: reading storage during render would mismatch SSR.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(COLLAPSE_KEY) ?? window.localStorage.getItem(LEGACY_COLLAPSE_KEY);
    } catch {
      // Storage disabled: start expanded.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(stored === "1");
  }, []);

  const setAndRemember = (next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
    } catch {
      // Private mode / storage disabled: the choice just won't persist.
    }
  };

  return (
    <div
      className={cn(
        "grid h-dvh grid-cols-1 overflow-hidden bg-background",
        collapsed ? "sm:grid-cols-[48px_minmax(0,1fr)]" : "sm:grid-cols-[264px_minmax(0,1fr)]",
      )}
    >
      <div className="hidden min-h-0 sm:block">
        {collapsed ? (
          <div className="flex h-full flex-col items-center gap-2 border-r border-border/60 pt-5">
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
              aria-label="New session"
              title="New session"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-4" />
            </Link>
          </div>
        ) : (
          <AppSidebar
            projects={projects}
            workspaces={workspaces}
            ownerId={ownerId}
            ownerLogin={ownerLogin}
            ownerAvatarUrl={ownerAvatarUrl}
            team={team}
            teams={teams}
            people={people}
            onCollapse={() => setAndRemember(true)}
          />
        )}
      </div>
      <main className="relative min-h-0 min-w-0 overflow-y-auto">{children}</main>
    </div>
  );
}
