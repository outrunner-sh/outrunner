/**
 * The org's admins reading a review session of its connector's (an
 * automation run's), read-only: its conversation and nothing else. Never
 * through the box's own URLs, whose token is good for all of the box (its
 * terminal, sending it messages): the server reads the conversation and
 * passes on only that. A live session's from its box, while the box is up
 * (never woken for this); an archived one's from its latest snapshot.
 */

import type { AgentEvent } from "@/lib/runtime/agent-protocol";

export type ReviewView =
  | { mode: "live" }
  | { mode: "archived"; events: AgentEvent[]; archivedAt: string }
  /** Neither: its box is down and it was never archived (it pauses idle). */
  | { mode: "none" };

export type ReviewViewDeps = {
  connectorRunSession(orgId: string, runId: string): Promise<{ workspaceId: string; connectorId: string } | null>;
  /** Reads as the connector, whose session it is (RLS keeps it theirs). */
  asConnector<T>(connectorId: string, work: () => Promise<T>): Promise<T>;
  /** Whether its box is up (nothing read from it, no token made). Inside
   *  asConnector. */
  boxUp(workspaceId: string): Promise<boolean>;
  /** The box's conversation stream (SSE), from `lastEventId` on, while its
   *  box is up; null when it isn't. Inside asConnector. */
  liveEventsUrl(workspaceId: string, lastEventId: string | null): Promise<string | null>;
  /** The latest snapshot's conversation; null when it has none. Inside
   *  asConnector. */
  latestArchive(workspaceId: string, connectorId: string): Promise<{ events: AgentEvent[]; archivedAt: string } | null>;
};

/** How the run's session can be read; null when it isn't the org's
 *  connector's run session. */
export async function reviewView(orgId: string, runId: string, deps: ReviewViewDeps): Promise<ReviewView | null> {
  const session = await deps.connectorRunSession(orgId, runId);
  if (!session) return null;
  return deps.asConnector(session.connectorId, async () => {
    // Up is enough to say: the stream's own route mints its URL.
    if (await deps.boxUp(session.workspaceId)) return { mode: "live" } as const;
    const archive = await deps.latestArchive(session.workspaceId, session.connectorId);
    return archive ? ({ mode: "archived", ...archive } as const) : ({ mode: "none" } as const);
  });
}

/** A resume point as the stream gives it (a byte offset), or none: a state
 *  event's "0" is no point to resume from (it would read it all again). */
export function lastEventIdFrom(value: string | null): string | null {
  return value && value !== "0" && /^\d{1,15}$/.test(value) ? value : null;
}

/** The box's stream to pass on, for the org's admins; null when it isn't
 *  the connector's run session, or its box is down. */
export async function reviewEventsUrl(
  orgId: string,
  runId: string,
  lastEventId: string | null,
  deps: Pick<ReviewViewDeps, "connectorRunSession" | "asConnector" | "liveEventsUrl">,
): Promise<string | null> {
  const session = await deps.connectorRunSession(orgId, runId);
  if (!session) return null;
  return deps.asConnector(session.connectorId, () => deps.liveEventsUrl(session.workspaceId, lastEventIdFrom(lastEventId)));
}
