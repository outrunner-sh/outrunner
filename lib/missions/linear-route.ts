/**
 * Linear issues routed to a Mission (docs/missions.md, "Triggers"): a
 * Mission's automation with the `linear.issue` trigger names Linear teams,
 * and an issue delegated to Outrunner in one of them becomes a request to
 * that Mission, rather than a session of its own. The Linear agent
 * (lib/trackers/linear-agent.ts) asks this first, after its own rules:
 *
 *   owned      an issue already with a session stays with it (the agent
 *              steers that session before asking)
 *   routes     the oldest enabled route naming the issue's team picks one
 *              Mission; none, and the issue goes today's way
 *   who        the person who delegated it (linked) needs read on the
 *              Mission's project; refused otherwise (never a session
 *              instead: the team chose the Mission)
 *   updates    what's said in the issue's agent session later reaches the
 *              same request (a `request_update`), never a fresh Ship
 *   stop       a stop, the issue taken back, or the issue closed cancels
 *              that request only: its Ships take no more work for it
 *   again      delegated again after its request was stopped (anywhere),
 *              it's a new request under a fresh key, so the Mission is told
 *              again; a delivery again of the same delegation is still one
 *   replies    the Mission's linear_reply posts in the agent session as
 *              Outrunner's app, whose own events Linear's webhook drops
 *              (isOwnLinearEvent); a prompt by the app is ignored here too
 *
 * What touches the world comes in as `deps` (linear-route.deps.ts).
 */

import type { LinearIssueEvent } from "@/lib/automations/run-event";
import type { MissionRunOutcome } from "@/lib/missions/automation-target";
import type { MissionRequest } from "@/lib/missions/slack-store";

/** A route: a Mission automation naming Linear teams. */
export type LinearRoute = { automationId: string; missionId: string; teamIds: string[]; createdAt: string };

export type LinearMissionDeps = {
  routes(orgId: string): Promise<LinearRoute[]>;
  missionTitle(missionId: string): Promise<string | null>;
  /** Whether a person can read the Mission's project. */
  canRead(userId: string, missionId: string): Promise<boolean>;
  /** Record the automation's run for the issue and run it: its request. */
  run(automationId: string, event: LinearIssueEvent): Promise<MissionRunOutcome | null>;
  /** The agent session's latest request. */
  forSession(agentSessionId: string): Promise<MissionRequest | null>;
  update(request: MissionRequest, update: { id: string; text: string; from: string | null }): Promise<"sent" | "cancelled" | "missing">;
  cancel(request: MissionRequest, reason: string): Promise<boolean>;
  /** The open Linear requests of an issue. */
  forIssue(installationId: string, issueId: string): Promise<MissionRequest[]>;
};

/** The request key a delegation runs under, which its run dedupes on too
 *  (nextDelegation picks it). */
export function delegationKey(event: Pick<LinearIssueEvent, "agentSessionId" | "delegation">): string {
  return event.delegation ?? `linear:${event.agentSessionId}`;
}

/**
 * The key for a delegation of this agent session, given its latest request:
 * the session's own while that request stands. Linear keeps one agent session
 * through every delegation of an issue, so once its request was cancelled
 * the next delegation takes the next key and is new work. A delivery again
 * of that delegation finds the same cancelled request, or its own open one,
 * so takes the same key: one run.
 */
export function nextDelegation(agentSessionId: string, latest: Pick<MissionRequest, "requestKey" | "status"> | null): string {
  const base = `linear:${agentSessionId}`;
  if (!latest) return base;
  if (latest.status !== "cancelled") return latest.requestKey;
  const n = latest.requestKey.startsWith(`${base}:`) ? Number(latest.requestKey.slice(base.length + 1)) : 1;
  return `${base}:${(Number.isInteger(n) && n > 0 ? n : 1) + 1}`;
}

/** The route an issue's team takes: the oldest naming it. */
export function pickRoute(routes: readonly LinearRoute[], teamId: string | null): LinearRoute | null {
  if (!teamId) return null;
  return [...routes].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).find((r) => r.teamIds.includes(teamId)) ?? null;
}

export type RouteOutcome = { routed: false } | { routed: true; said: string };

/** An issue delegated: a Mission's request, if a route takes it; what to
 *  say in Linear. */
export async function routeIssue(
  input: { orgId: string; teamId: string | null; event: LinearIssueEvent },
  deps: LinearMissionDeps,
): Promise<RouteOutcome> {
  const route = pickRoute(await deps.routes(input.orgId), input.teamId);
  if (!route) return { routed: false };
  const title = (await deps.missionTitle(route.missionId)) ?? "Mission";
  if (input.event.requestedBy && !(await deps.canRead(input.event.requestedBy, route.missionId))) {
    return { routed: true, said: `This team's issues go to the Mission "${title}", whose project you can't read in Outrunner, so it didn't take this.` };
  }
  const delegation = nextDelegation(input.event.agentSessionId, await deps.forSession(input.event.agentSessionId));
  const outcome = await deps.run(route.automationId, { ...input.event, delegation });
  if (!outcome) return { routed: true, said: `The Mission "${title}" has this already.` };
  if (outcome.status === "ready") return { routed: true, said: `Sent to the Mission "${title}". It answers here.` };
  return { routed: true, said: `The Mission "${title}" didn't take this: ${outcome.reason ?? "it couldn't."}` };
}

/** Something said in the issue's agent session, for a Mission's request:
 *  null when the session isn't one. */
export async function promptedForMission(
  input: { agentSessionId: string; appUserId: string | null; speaker: string | null; speakerOwner: string | null; activityId: string; text: string; from: string | null },
  deps: LinearMissionDeps,
): Promise<string | null | "ignored"> {
  const request = await deps.forSession(input.agentSessionId);
  if (!request) return null;
  // Our own words, echoed back: never an update.
  if (input.speaker && input.appUserId && input.speaker === input.appUserId) return "ignored";
  if (!input.speakerOwner || !(await deps.canRead(input.speakerOwner, request.missionId))) {
    return "Only people linked to Outrunner who can read the Mission's project can add to this.";
  }
  if (!input.text.trim()) return "That came through empty, so nothing was sent.";
  const sent = await deps.update(request, { id: input.activityId, text: input.text, from: input.from });
  if (sent === "cancelled") return "This request was stopped. Delegate the issue again to start it over.";
  if (sent === "missing") return null;
  return "Sent to the Mission.";
}

/** A stop in the issue's agent session: its request cancelled. Null when
 *  the session isn't a Mission's. */
export async function stopForMission(agentSessionId: string, deps: LinearMissionDeps): Promise<"stopped" | null> {
  const request = await deps.forSession(agentSessionId);
  if (!request) return null;
  await deps.cancel(request, "stopped in Linear");
  return "stopped";
}

/** The issue taken back, or closed: each of its Mission requests cancelled,
 *  and only those. How many. */
export async function cancelIssue(installationId: string, issueId: string, reason: string, deps: LinearMissionDeps): Promise<number> {
  let cancelled = 0;
  for (const request of await deps.forIssue(installationId, issueId)) {
    if (await deps.cancel(request, reason)) cancelled++;
  }
  return cancelled;
}
