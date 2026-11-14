"use client";

import { Archive, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { useNow } from "@/hooks/use-now";
import { relativeTime } from "@/lib/nav/sidebar";
import { type ArchivedSession, searchArchived } from "@/lib/session/archived-sessions";

/**
 * The archived sessions, searchable. View opens its Replay, read from its
 * Snapshot with no computer started; Restore opens the session, which brings
 * it back as it opens (hooks/use-restore-on-open.ts) and returns it to the
 * sidebar.
 */
export function ArchivedSessionsList({ sessions }: { sessions: ArchivedSession[] }) {
  const [query, setQuery] = useState("");
  const now = useNow(60_000);
  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 px-6 py-10 text-center">
        <Archive aria-hidden className="size-4 text-muted-foreground" />
        <p className="text-sm text-foreground">No archived sessions</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Archive a session from its row in the sidebar, or its header, and it moves here.
        </p>
      </div>
    );
  }
  const shown = searchArchived(sessions, query);
  return (
    <div className="space-y-3">
      <label className="flex max-w-sm items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-sm focus-within:border-border">
        <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search archived sessions"
          aria-label="Search archived sessions"
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </label>
      {shown.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">No archived session matches “{query.trim()}”.</p>
      ) : (
        <ul className="divide-y divide-border/60 border-y border-border/60">
          {shown.map((session) => (
            <li key={session.id} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-sm text-foreground" title={session.title}>
                  {session.title}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {[session.project, session.branch].filter(Boolean).join(" · ")}
                  {" · "}
                  {session.archiving ? (
                    "Archiving…"
                  ) : (
                    <time dateTime={session.archivedAt} suppressHydrationWarning>
                      {archivedWhen(session.archivedAt, now)}
                    </time>
                  )}
                </p>
                {!session.saved && (
                  <p className="text-xs text-amber-400">
                    Archived without its files, so it can&apos;t be viewed or restored. Anything pushed to GitHub is
                    kept.
                  </p>
                )}
              </div>
              {session.saved && !session.archiving && (
                <div className="flex shrink-0 items-center gap-2">
                  <Link
                    href={`/workspaces/${session.id}/replay`}
                    className="rounded-md px-2.5 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    View
                  </Link>
                  <Link
                    href={`/workspaces/${session.id}`}
                    title="Brings it back on a cloud computer, and into the sidebar"
                    className="rounded-md border border-border/60 px-2.5 py-1 text-[13px] text-foreground transition-colors hover:bg-accent"
                  >
                    Restore
                  </Link>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function archivedWhen(at: string, now: number): string {
  const ago = relativeTime(at, now);
  if (!ago) return "Archived";
  return ago === "now" ? "Archived just now" : `Archived ${ago} ago`;
}
