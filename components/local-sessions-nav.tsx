"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Laptop, MessageSquare, Plus } from "lucide-react";

import { ProjectAvatar } from "@/components/project-avatar";
import { useLocalSessions } from "@/hooks/use-local-sessions";
import { startNextSessionIn } from "@/hooks/use-session-location";
import type { LocalSession } from "@/lib/desktop/local-runtime";
import { groupLocalSessions, localSessionLabel } from "@/lib/desktop/local-sessions";
import { cn } from "@/lib/utils";

/**
 * "This Mac": this Mac's local sessions, grouped by the folder they work in —
 * the way cloud workspaces sit under their repository — for the studio's
 * sidebar. The studio reads the sessions (useLocalSessions) so it can also
 * label the cloud section below; renders nothing when there are none.
 */
export function LocalSessionsNav({
  sessions,
  activeWorkspaceId,
}: {
  sessions: LocalSession[];
  activeWorkspaceId?: string;
}) {
  const router = useRouter();
  if (sessions.length === 0) return null;
  return (
    <nav className="studio-nav is-local" aria-label="Sessions on this Mac">
      <div className="studio-nav-section">
        <Laptop /> This Mac
      </div>
      {groupLocalSessions(sessions).map((group) => (
        <div key={group.folder} className="studio-nav-group">
          <div className="studio-nav-project" title={group.folder}>
            <ProjectAvatar name={group.label} className="size-4" />
            <span className="studio-nav-project-name">{group.label}</span>
            <button
              type="button"
              className="studio-nav-add"
              title={`New session in ${group.label}`}
              aria-label={`New session in ${group.label}`}
              onClick={() => {
                startNextSessionIn(group.folder);
                router.push("/new");
              }}
            >
              <Plus />
            </button>
          </div>
          {group.sessions.map((session) => (
            <Link
              key={session.workspaceId}
              href={`/local/${session.workspaceId}`}
              className={cn("studio-nav-item", session.workspaceId === activeWorkspaceId && "is-active")}
              title={session.worktree}
            >
              <MessageSquare className="studio-nav-item-icon" />
              <span className="studio-nav-item-label">{localSessionLabel(session)}</span>
            </Link>
          ))}
        </div>
      ))}
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
      <div className="mt-2 space-y-2">
        {groupLocalSessions(local.sessions).map((group) => (
          <div key={group.folder}>
            <p
              title={group.folder}
              className="flex items-center gap-2.5 px-1 py-1.5 text-sm text-foreground"
            >
              <ProjectAvatar name={group.label} />
              <span className="truncate">{group.label}</span>
            </p>
            {group.sessions.map((session) => (
              <Link
                key={session.workspaceId}
                href={`/local/${session.workspaceId}`}
                title={session.worktree}
                className="ml-3 flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <MessageSquare className="size-3.5 shrink-0" />
                <span className="truncate">{localSessionLabel(session)}</span>
              </Link>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
