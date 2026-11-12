/** Linear issues routed to a Mission, wired (lib/missions/linear-route.ts). */

import { recordOf } from "@/lib/automations/runs";
import { automationCandidates, recordRuns } from "@/lib/db/automation-runs";
import { startMissionRun } from "@/lib/missions/automation-target";
import { missionRunDeps } from "@/lib/missions/automation-target.deps";
import type { LinearMissionDeps } from "@/lib/missions/linear-route";
import { cancelMissionRequest, sendRequestUpdate } from "@/lib/missions/requests.deps";
import { missionLevel } from "@/lib/missions/slack-route.deps";
import { requestByKey, requestForExternalSession, type MissionRequest } from "@/lib/missions/slack-store";
import { sessionById } from "@/lib/missions/store";
import { allows } from "@/lib/orgs/access";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

function db() {
  return createSupabaseAdminClient();
}

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
      return (data ?? [])
        .filter((a) => a.triggers.includes("linear.issue") && a.target_mission_id)
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
      const recorded = await recordRuns([recordOf(candidate, event, `linear:${event.agentSessionId}`)]);
      const run = recorded.get(`${candidate.automationId}:${candidate.projectId}`);
      if (!run) return null;
      return startMissionRun({ runId: run.runId, candidate, event }, missionRunDeps());
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
