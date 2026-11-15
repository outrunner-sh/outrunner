/**
 * The idle sweep's real wiring (lib/missions/idle-pause.ts): the database's
 * sweep functions, which queue the posts the tick then sends, and the org's
 * audit log.
 */

import { recordAudit } from "@/lib/audit/record";
import { IDLE_AFTER_MS, IDLE_GRACE_MS, IDLE_SWEEP_MAX, type IdleSweepDeps } from "@/lib/missions/idle-pause";
import { offerIdlePauses, pauseIdleMissions } from "@/lib/missions/slack-store";
import { IDLE_OFFER_TEXT, IDLE_PAUSE_TEXT } from "@/lib/missions/slack-text";
import { sessionById } from "@/lib/missions/store";

export function idleSweepDeps(): IdleSweepDeps {
  return {
    offer: () => offerIdlePauses(IDLE_AFTER_MS / 1000, IDLE_OFFER_TEXT, IDLE_SWEEP_MAX),
    pause: () => pauseIdleMissions(IDLE_GRACE_MS / 1000, IDLE_PAUSE_TEXT, IDLE_SWEEP_MAX),
    audit: async (binding) => {
      const mission = await sessionById(binding.missionId).catch(() => null);
      await recordAudit({
        orgId: binding.orgId,
        actor: "system",
        action: "mission.slack_idle_paused",
        resource: { type: "mission", id: binding.missionId, label: mission ? (mission.title ?? mission.branch) : null },
        details: {
          slack_team_id: binding.teamId,
          slack_channel_id: binding.channelId,
          last_human_at: binding.lastHumanAt ?? null,
          idle_warned_at: binding.idleWarnedAt ?? null,
        },
      });
    },
    log: (message, error) => console.error(message, error),
  };
}
