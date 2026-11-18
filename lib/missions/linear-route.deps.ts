/** Linear issues routed to a Mission, wired (lib/missions/linear-route.ts). */

import { recordOf } from "@/lib/automations/runs";
import { automationCandidates, recordRuns, retakeRun } from "@/lib/db/automation-runs";
import { startMissionRun } from "@/lib/missions/automation-target";
import { missionRunDeps } from "@/lib/missions/automation-target.deps";
import { delegationKey, type LinearMissionDeps } from "@/lib/missions/linear-route";
import { cancelMissionRequest, sendRequestUpdate } from "@/lib/missions/requests.deps";
import { missionLevel } from "@/lib/missions/slack-route.deps";
import { requestByKey, requestForExternalSession, type MissionRequest } from "@/lib/missions/slack-store";
import { sessionById } from "@/lib/missions/store";
import { allows } from "@/lib/orgs/access";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

function db() {
  return createSupabaseAdminClient();
}

/** A Mission in one of these takes no work. */
const ENDED = new Set(["archiving", "archived", "destroying", "destroyed", "failed"]);

export function linearMissionDeps(): LinearMissionDeps {
  return {
    routes: async (orgId) => {
      const { data, error } = await db()
        .from("automations")
        .select("id, target_mission_id, linear_team_ids, triggers, created_at")
        .eq("org_id", orgId)
        .eq("target_kind", "mission")
        .eq("enabled", true)
        .is("archived_at", null);
      // Before the migration that adds them: no routes, today's way.
      if (error && (error.code === "42703" || error.code === "PGRST204")) return [];
      if (error) throw error;
      const linear = (data ?? []).filter((a) => a.triggers.includes("linear.issue") && a.target_mission_id);
      if (linear.length === 0) return [];
      // Only a route that can take work routes: its Mission live, and its
      // owner's approval standing. Any other would take every issue of its
      // teams only to refuse them, ahead of a route that works.
      const [missions, delegations] = await Promise.all([
        db().from("workspaces").select("id, owner_id, status").in("id", [...new Set(linear.map((a) => a.target_mission_id as string))]),
        db().from("mission_delegations").select("automation_id, approved_by, approved_at, revoked_at").in("automation_id", linear.map((a) => a.id)),
      ]);
      if (missions.error) throw missions.error;
      if (delegations.error) throw delegations.error;
      const missionOf = new Map((missions.data ?? []).map((m) => [m.id, m]));
      const delegationOf = new Map((delegations.data ?? []).map((d) => [d.automation_id, d]));
      return linear
        .filter((a) => {
          const mission = missionOf.get(a.target_mission_id as string);
          const d = delegationOf.get(a.id);
          if (!mission || ENDED.has(mission.status)) return false;
          return !!d?.approved_at && !d.revoked_at && d.approved_by === mission.owner_id;
        })
        .map((a) => ({ automationId: a.id, missionId: a.target_mission_id as string, teamIds: a.linear_team_ids, createdAt: a.created_at }));
    },
    missionTitle: async (missionId) => (await sessionById(missionId))?.title ?? null,
    canRead: async (userId, missionId) => {
      const mission = await sessionById(missionId);
      return mission ? allows(await missionLevel(userId, mission), "read") : false;
    },
    run: async (automationId, event) => {
      const [candidate] = await automationCandidates([automationId]);
      if (!candidate) return { status: "refused", reason: "its automation is off." };
      const key = delegationKey(event);
      const recorded = await recordRuns([recordOf(candidate, event, key)]);
      // A key whose run made nothing wasn't spent: this delegation takes it.
      const runId = recorded.get(`${candidate.automationId}:${candidate.projectId}`)?.runId ?? (await retakeRun(candidate.automationId, candidate.projectId, key, event));
      if (!runId) return null;
      return startMissionRun({ runId, candidate, event }, missionRunDeps());
    },
    forSession: (agentSessionId) => requestForExternalSession("linear", agentSessionId),
    update: (request, update) => sendRequestUpdate(request.missionId, request.requestKey, update),
    cancel: (request, reason) => cancelMissionRequest(request.missionId, request.requestKey, reason),
    forIssue: async (installationId, issueId) => {
      const { data, error } = await db()
        .from("mission_slack_requests")
        .select("mission_id, request_key")
        .eq("source", "linear")
        .eq("installation_id", installationId)
        .eq("external_ref", issueId)
        .eq("status", "open");
      if (error && (error.code === "42703" || error.code === "PGRST204")) return [];
      if (error) throw error;
      const found = await Promise.all((data ?? []).map((r) => requestByKey(r.mission_id, r.request_key)));
      return found.filter((r): r is MissionRequest => r !== null);
    },
  };
}
