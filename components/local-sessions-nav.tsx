"use client";

import Link from "next/link";
import { Laptop, MessageSquare } from "lucide-react";

import { localSessionLabel, useLocalSessions } from "@/hooks/use-local-sessions";
import { cn } from "@/lib/utils";

/**
 * "This Mac": the local sessions the agent on this Mac knows, for the studio's
 * sidebar. Renders nothing outside the Mac app or when there are none.
 */
export function LocalSessionsNav({ activeWorkspaceId }: { activeWorkspaceId?: string }) {
  const local = useLocalSessions();
  if (local.sessions.length === 0) return null;
  return (
    // Sized to its sessions, up to a cap past which it scrolls on its own, so a
    // long list never pushes the repositories below out of reach. (vh: WebKit
    // leaves a % max-height here unresolved.)
    <nav className="studio-nav" aria-label="Sessions on this Mac" style={{ flex: "none", maxHeight: "45vh" }}>
      <div className="studio-nav-group">
        <div className="studio-nav-project">
          <Laptop className="size-4" />
          <span className="studio-nav-project-name">This Mac</span>
        </div>
        {local.sessions.map((session) => (
          <Link
            key={session.workspaceId}
            href={`/local/${session.workspaceId}`}
            className={cn("studio-nav-item", session.workspaceId === activeWorkspaceId && "is-active")}
            title={`${session.name} · ${session.worktree}`}
          >
            <MessageSquare className="studio-nav-item-icon" />
            <span className="studio-nav-item-label">{localSessionLabel(session)}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}

/** The same list for the home page's sidebar, in its own (plainer) style. */
export function HomeLocalSessions() {
  const local = useLocalSessions();
  if (local.sessions.length === 0) return null;
  return (
    <div className="mt-6">
      <h2 className="flex items-center gap-1.5 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Laptop className="size-3.5" /> This Mac
      </h2>
      <div className="mt-2 space-y-0.5">
        {local.sessions.map((session) => (
          <Link
            key={session.workspaceId}
            href={`/local/${session.workspaceId}`}
            title={`${session.name} · ${session.worktree}`}
            className="flex w-full items-baseline gap-2 rounded-md px-1 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
          >
            <span className="min-w-0 truncate">{localSessionLabel(session)}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{session.name}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
