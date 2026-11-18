/** Watched Slack channels, wired (lib/missions/slack-watch.ts). */

import { startRun } from "@/lib/automations/runs";
import { startDeps } from "@/lib/automations/start-deps";
import { automationCandidates, recordRuns } from "@/lib/db/automation-runs";
import { getInstallation } from "@/lib/db/slack-agent";
import type { Watcher, WatchDeps } from "@/lib/missions/slack-watch";
import { botIdentity, messagePermalink, userNames } from "@/lib/slack/web";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** The enabled Mission automations watching a channel, of orgs someone has
 *  linked that Slack workspace into (a watch is checked when it's saved;
 *  this keeps another org's from hearing it whatever was saved). Before the
 *  migration that adds them, none. */
export async function watchersOf(teamId: string, channelId: string): Promise<Watcher[]> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("automations")
    .select("id, org_id, allowed_app_ids, triggers")
    .eq("watch_team_id", teamId)
    .eq("watch_channel_id", channelId)
    .eq("target_kind", "mission")
    .eq("enabled", true);
  if (error && (error.code === "42703" || error.code === "PGRST204" || error.code === "42P01")) return [];
  if (error) throw error;
  const watching = (data ?? []).filter((a) => a.triggers.includes("slack.message"));
  if (watching.length === 0) return [];
  const { data: links, error: linksError } = await supabase
    .from("slack_links")
    .select("org_id")
    .eq("team_id", teamId)
    .in("org_id", [...new Set(watching.map((a) => a.org_id))]);
  if (linksError) throw linksError;
  const linked = new Set((links ?? []).map((l) => l.org_id));
  return watching.filter((a) => linked.has(a.org_id)).map((a) => ({ automationId: a.id, allowedAppIds: a.allowed_app_ids }));
}

const selves = new Map<string, Promise<{ userId: string | null; botId: string | null }>>();

async function token(teamId: string): Promise<string> {
  const install = await getInstallation(teamId);
  if (!install) throw new Error(`Outrunner isn't installed in Slack workspace ${teamId}`);
  return install.botToken;
}

export function watchDeps(): WatchDeps {
  return {
    watchers: watchersOf,
    self: (teamId) => {
      let known = selves.get(teamId);
      if (!known) {
        // A failure rejects (and isn't kept): the loop guard never runs on
        // half an identity; the saved message is tried again.
        known = (async () => {
          const install = await getInstallation(teamId);
          if (!install) return { userId: null, botId: null };
          const ids = await botIdentity(install.botToken);
          return { userId: ids.userId ?? install.botUserId ?? null, botId: ids.botId };
        })();
        selves.set(teamId, known);
        // Not kept on failure: the next message asks again.
        known.catch(() => selves.delete(teamId));
      }
      return known;
    },
    candidates: automationCandidates,
    recordRuns: (runs) => recordRuns(runs),
    startRun: (run) => startRun(run, startDeps()),
    name: async (teamId, userId) => (await userNames(await token(teamId), [userId])).get(userId) ?? null,
    permalink: async (teamId, channelId, ts) => messagePermalink(await token(teamId), channelId, ts),
  };
}
