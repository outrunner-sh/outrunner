/**
 * Who may point an automation at a Mission, and what that makes of it
 * (docs/missions.md, "Triggers"): only someone with write on the Mission's
 * project; its one repository is the Mission's project's; its target never
 * changes once made; and its runs wait for the Mission's owner to approve it
 * (approved at once when the owner makes it). Shared by the org's
 * automation routes and the Mission's own.
 */

import type { AutomationInput } from "@/lib/automations/rules";
import type { AccessLevel } from "@/lib/orgs/access";
import { allows } from "@/lib/orgs/access";
import type { Workspace } from "@/lib/runtime/types";

export type TargetDeps = {
  mission(id: string): Promise<Workspace | null>;
  level(userId: string, mission: Workspace): Promise<AccessLevel | null>;
};

export type TargetCheck = { ok: true; mission: Workspace | null; input: Partial<AutomationInput> } | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Check an automation's Mission target for `callerId` in `orgId`, and fix
 * what follows from it. `existing`: the automation's target as saved (a
 * change); its kind can't change.
 */
export async function checkMissionTarget(
  orgId: string,
  callerId: string,
  input: Partial<AutomationInput>,
  existing: { kind: "session" } | { kind: "mission"; missionId: string } | null,
  deps: TargetDeps,
): Promise<TargetCheck> {
  const sent = input.target;
  if (existing && sent && (sent.kind !== existing.kind || (sent.kind === "mission" && existing.kind === "mission" && sent.missionId !== existing.missionId))) {
    return { ok: false, status: 400, error: "An automation's destination can't change: make a new one." };
  }
  const missionId = sent?.kind === "mission" ? sent.missionId : existing?.kind === "mission" ? existing.missionId : null;
  if (!missionId) {
    // A session's: as before, but the Mission-only triggers need a Mission.
    if (input.webhookSecret !== undefined) return { ok: false, status: 400, error: "Only a Mission's webhook takes a signing secret." };
    return { ok: true, mission: null, input };
  }
  const mission = await deps.mission(missionId);
  if (!mission || mission.kind !== "mission" || mission.orgId !== orgId || mission.status === "destroyed" || mission.status === "destroying") {
    return { ok: false, status: 404, error: "No such Mission in this org." };
  }
  if (!allows(await deps.level(callerId, mission), "write")) {
    return { ok: false, status: 403, error: "Sending an automation's runs to a Mission needs write on its project." };
  }
  return {
    ok: true,
    mission,
    // Its one repository: the Mission's project's (a Mission's run works in
    // none; this is what its runs are recorded on).
    input: { ...input, ...(input.projectIds !== undefined || !existing ? { projectIds: [mission.projectId] } : {}) },
  };
}
