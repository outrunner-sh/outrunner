"use client";

import Link from "next/link";
import { ChevronRight, Folder, GitBranch } from "lucide-react";
import { useMemo } from "react";

import { useAppData } from "@/components/app-data";
import { StandingMark } from "@/components/sidebar-status";
import { SkeletonRows } from "@/components/ui/skeleton-swap";
import { useLocalSessions } from "@/hooks/use-local-sessions";
import { useNow } from "@/hooks/use-now";
import { useStandings } from "@/hooks/use-standings";
import { relativeTime } from "@/lib/nav/sidebar";
import { recentSessionGroups, recentSessions } from "@/lib/session/recent-sessions";

/** A small home list from the same shared data the sidebar already reads. */
export function RecentSessions() {
  const data = useAppData();
  const local = useLocalSessions();
  const standings = useStandings();
  const now = useNow(60_000);
  const sessions = useMemo(
    () => recentSessions(data?.workspaces ?? [], local.sessions, [...(data?.projects ?? []), ...(data?.hiddenProjects ?? [])]),
    [data, local.sessions],
  );

  if (sessions.length === 0) {
    return data === null || local.state === "loading" ? (
      <div className="mt-8" aria-label="Loading recent sessions" aria-busy="true">
        <SkeletonRows rows={2} rowHeight={36} />
      </div>
    ) : null;
  }

  return (
    <section className="@container mt-8 space-y-3" aria-labelledby="recent-sessions-heading">
      <div className="flex items-center justify-between gap-3 px-2">
        <h2 id="recent-sessions-heading" className="text-xs font-medium text-muted-foreground">Recent sessions</h2>
        <Link href="/workspaces" className="rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
          View all sessions
        </Link>
      </div>
      {recentSessionGroups(sessions, now).map((group) => (
        <details key={group.label} open className="group/recent">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-3 transition-transform group-open/recent:rotate-90" />
            <span>{group.label}</span>
            <span className="tabular-nums">{group.sessions.length}</span>
          </summary>
          <ul className="mt-1 space-y-1">
            {group.sessions.map((session) => {
              const Icon = session.local ? Folder : GitBranch;
              const standing = !session.local ? standings[session.id] : undefined;
              return (
                <li key={session.href}>
                  <Link href={session.href} title={`${session.title} · ${session.project}`} className="flex min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="grid size-7 shrink-0 place-items-center rounded-full border border-border/60 bg-sidebar text-muted-foreground">
                      <Icon aria-hidden className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{session.title}</span>
                    <span className="hidden max-w-32 truncate text-xs text-muted-foreground @lg:block">{session.project}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{relativeTime(session.at, now)}</span>
                    {standing && <StandingMark standing={standing} />}
                  </Link>
                </li>
              );
            })}
          </ul>
        </details>
      ))}
    </section>
  );
}
