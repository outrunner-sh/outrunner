/**
 * The owner's Missions read for the sidebar and the Runners pane
 * (lib/missions/view.ts), with the service role and scoped to the owner
 * here: their Missions, their Runners. Where each stands (working, needing
 * you, unread) is every session's standing (lib/session/standing.ts), read
 * as the sidebar reads the user's other sessions; the Missions' own part is
 * their Runners' pull requests and groups.
 */

import { runnerState } from "@/lib/missions/rules";
import {
  briefSummary,
  missionStatus,
  type MissionView,
  type RunnerCheck,
  runnerGroup,
  type RunnerPullView,
  type RunnerView,
} from "@/lib/missions/view";
import { toWorkspace, toWorkspacePullRequest } from "@/lib/db/mappers";
import { readStandings } from "@/lib/db/session-standing";
import type { Workspace } from "@/lib/runtime/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

function db() {
  return createSupabaseAdminClient();
}

function checksOf(value: unknown): RunnerCheck[] {
  return Array.isArray(value)
    ? value.flatMap((c) =>
        c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string"
          ? [
              {
                name: (c as { name: string }).name,
                status: String((c as { status?: unknown }).status ?? "completed"),
                conclusion: typeof (c as { conclusion?: unknown }).conclusion === "string" ? (c as { conclusion: string }).conclusion : null,
                url: typeof (c as { url?: unknown }).url === "string" ? (c as { url: string }).url : null,
              },
            ]
          : [],
      )
    : [];
}

/** The owner's Missions in an org (or all of theirs), in their order. */
export async function missionsFor(ownerId: string, orgId: string | null, only?: string): Promise<MissionView[]> {
  // Read under the user's own client (their sessions, their marks), from the
  // routes that call this.
  let query = db().from("workspaces").select("*").eq("owner_id", ownerId).eq("kind", "mission").not("status", "in", "(destroyed,destroying)");
  if (orgId) query = query.eq("org_id", orgId);
  if (only) query = query.eq("id", only);
  const { data: missionRows, error } = await query.order("created_at", { ascending: true });
  if (error) throw error;
  const missions = (missionRows ?? []).map(toWorkspace);
  if (missions.length === 0) return [];
  const ids = missions.map((m) => m.id);

  const { data: runnerRows, error: runnersError } = await db()
    .from("workspaces")
    .select("*")
    .in("parent_mission_id", ids)
    .eq("owner_id", ownerId)
    .not("status", "in", "(destroyed,destroying)");
  if (runnersError) throw runnersError;
  const runners = (runnerRows ?? []).map(toWorkspace);
  const runnerIds = runners.map((r) => r.id);
  const envIds = [...new Set(missions.flatMap((m) => (m.environmentId ? [m.environmentId] : [])))];

  const [profiles, environments, briefs, pulls, watches, events] = await Promise.all([
    db().from("mission_profiles").select("mission_id, icon, position").in("mission_id", ids),
    envIds.length ? db().from("environments").select("id, name").in("id", envIds) : Promise.resolve({ data: [] }),
    runnerIds.length ? db().from("mission_runner_briefs").select("runner_id, brief").in("runner_id", runnerIds) : Promise.resolve({ data: [] }),
    runnerIds.length ? db().from("runner_pull_requests").select("*").in("runner_id", runnerIds) : Promise.resolve({ data: [] }),
    runnerIds.length ? db().from("turn_watches").select("workspace_id").in("workspace_id", runnerIds) : Promise.resolve({ data: [] }),
    runnerIds.length
      ? db().from("mission_events").select("runner_id, kind, payload, created_at").in("runner_id", runnerIds).order("created_at", { ascending: false }).limit(500)
      : Promise.resolve({ data: [] }),
  ]);
  const profileOf = new Map((profiles.data ?? []).map((p) => [p.mission_id, p]));
  const envName = new Map((environments.data ?? []).map((e: { id: string; name: string }) => [e.id, e.name]));
  const briefOf = new Map((briefs.data ?? []).map((b: { runner_id: string; brief: string }) => [b.runner_id, b.brief]));
  const watched = new Set((watches.data ?? []).map((w: { workspace_id: string }) => w.workspace_id));
  // Each Runner's latest event: a turn that couldn't end, still standing.
  const latestEvent = new Map<string, { kind: string; reason: string | null }>();
  for (const e of (events.data ?? []) as { runner_id: string; kind: string; payload: unknown }[]) {
    if (!latestEvent.has(e.runner_id)) latestEvent.set(e.runner_id, { kind: e.kind, reason: ((e.payload ?? {}) as { reason?: string }).reason ?? null });
  }

  const now = Date.now();
  // Where each stands, as the sidebar has every session: the pull request of
  // each that GitHub last told of (pull_requests), its agent as the server's
  // watch read it, and the user's own marks.
  const { data: sharedPulls } = await db().from("pull_requests").select("*").in("workspace_id", [...ids, ...runnerIds]);
  const pullOf: Record<string, ReturnType<typeof toWorkspacePullRequest>> = {};
  for (const row of sharedPulls ?? []) pullOf[row.workspace_id] ??= toWorkspacePullRequest(row);
  const standings = await readStandings(ownerId, [...missions, ...runners], pullOf, now).catch((error: unknown) => {
    console.error("Missions: couldn't read where sessions stand", error);
    return {} as Awaited<ReturnType<typeof readStandings>>;
  });
  const views = await Promise.all(
    missions.map(async (mission): Promise<MissionView & { position: number | null }> => {
      const own = runners.filter((r) => r.parentMissionId === mission.id);
      const runnerViews: RunnerView[] = own.map((runner) => {
        const rows = ((pulls.data ?? []) as Record<string, unknown>[]).filter((p) => p.runner_id === runner.id);
        const pullViews: RunnerPullView[] = rows.map((p) => ({
          repo: String(p.repo),
          number: Number(p.number),
          url: String(p.url),
          title: String(p.title ?? ""),
          state: p.state as RunnerPullView["state"],
          verdict: (p.verdict as RunnerPullView["verdict"]) ?? null,
          reason: (p.verdict_reason as string | null) ?? null,
          additions: (p.additions as number | null) ?? null,
          deletions: (p.deletions as number | null) ?? null,
          checks: checksOf(p.checks),
          reviewState: (p.review_state as RunnerPullView["reviewState"]) ?? null,
          mergeableState: (p.mergeable_state as string | null) ?? null,
          endedAt: p.state === "open" ? null : ((p.checked_at as string | null) ?? null),
        }));
        const standing = standings[runner.id] ?? null;
        const state = runnerState(runner.status, standing ? standing.standing === "working" : watched.has(runner.id));
        const latest = latestEvent.get(runner.id);
        const { group, attention } = runnerGroup(
          {
            state,
            pulls: pullViews,
            lostCause: latest?.kind === "needs_attention" ? latest.reason : null,
            errorMessage: runner.errorMessage,
            standing,
          },
          now,
        );
        return {
          id: runner.id,
          name: runner.title ?? runner.branch,
          summary: briefSummary(briefOf.get(runner.id) ?? null),
          state,
          branch: runner.branch,
          pulls: pullViews,
          group,
          attention,
          standing,
          createdAt: runner.createdAt,
        };
      });
      const readyCount = runnerViews
        .filter((r) => r.group === "ready_to_merge" || r.group === "ready_to_review")
        .reduce((n, r) => n + r.pulls.filter((p) => p.state === "open" && p.verdict === "ready").length, 0);
      const profile = profileOf.get(mission.id);
      return {
        id: mission.id,
        title: mission.title ?? "New Mission",
        icon: profile?.icon ?? null,
        position: profile?.position ?? null,
        status: missionStatus({ standing: standings[mission.id] ?? null, runners: runnerViews }),
        readyCount,
        liveRunners: own.filter((r) => !["archived", "archiving", "failed"].includes(r.status)).length,
        environment: mission.environmentId ? { id: mission.environmentId, name: envName.get(mission.environmentId) ?? "Project" } : null,
        sessionStatus: mission.status,
        standing: standings[mission.id] ?? null,
        runners: runnerViews.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        createdAt: mission.createdAt,
      };
    }),
  );
  // Where its owner put it; new ones at the end, oldest first.
  return views
    .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.createdAt.localeCompare(b.createdAt))
    .map(({ position: _, ...view }) => {
      void _;
      return view;
    });
}

/** Whether `ownerId` owns the Mission. */
export async function ownsMission(ownerId: string, missionId: string): Promise<Workspace | null> {
  const { data, error } = await db().from("workspaces").select("*").eq("id", missionId).eq("owner_id", ownerId).eq("kind", "mission").maybeSingle();
  if (error) throw error;
  return data ? toWorkspace(data) : null;
}

export async function setMissionProfile(missionId: string, patch: { icon?: string; position?: number }): Promise<void> {
  const { error } = await db().from("mission_profiles").upsert({ mission_id: missionId, ...patch }, { onConflict: "mission_id" });
  if (error) throw error;
}
