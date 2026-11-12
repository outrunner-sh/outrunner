/**
 * Watched Slack channels (docs/missions.md, "Triggers"): a Mission's
 * automation with the `slack.message` trigger hears new messages in its
 * channel, and each passes its filter (lib/missions/automation-target.ts) or
 * doesn't, which its run history keeps.
 *
 *   which      new messages in the channel (not in threads, not mentions of
 *              Outrunner: those are the bound channel's route's, or the
 *              agent's)
 *   apps       an app's or bot's message only from the app ids the
 *              automation allows; Outrunner's own output never, whatever
 *              the list says, so a Mission's posts can't loop back
 *   once       one message is one run an automation (its key), and one
 *              request anywhere (the message claims, at the run)
 *
 * The events endpoint saves a watched message before it answers Slack
 * (lib/missions/slack-inbound.ts), and its processor runs this.
 */

import type { PendingRun } from "@/lib/automations/runs";
import { recordOf } from "@/lib/automations/runs";
import type { SlackWatchEvent } from "@/lib/automations/run-event";
import type { Recorded, RunCandidate, RunRecord } from "@/lib/db/automation-runs";
import type { AgentMessage } from "@/lib/slack/agent-run";

/** A watching automation, as the endpoint needs to know of it. */
export type Watcher = { automationId: string; allowedAppIds: string[] };

export type WatchDeps = {
  watchers(teamId: string, channelId: string): Promise<Watcher[]>;
  /** The bot's own ids in the workspace: its posts are never heard. */
  self(teamId: string): Promise<{ userId: string | null; botId: string | null }>;
  candidates(automationIds: readonly string[]): Promise<RunCandidate[]>;
  recordRuns(runs: RunRecord[]): Promise<Map<string, Recorded>>;
  startRun(run: PendingRun): Promise<void>;
  name(teamId: string, userId: string): Promise<string | null>;
  permalink(teamId: string, channelId: string, ts: string): Promise<string | null>;
};

/** Whether a message is one a watch may hear at all (before knowing whose). */
export function watchable(message: AgentMessage): boolean {
  return (
    message.channelType !== "im" &&
    /^[CG]/.test(message.channel) &&
    !message.mention &&
    !message.threadTs &&
    message.text.trim().length > 0
  );
}

/** The watchers that hear this message: a person's, any; an app's, those
 *  allowing its app. */
export function hearing(message: AgentMessage, watchers: readonly Watcher[]): Watcher[] {
  if (!message.botId) return [...watchers];
  if (!message.appId) return [];
  return watchers.filter((w) => w.allowedAppIds.includes(message.appId as string));
}

/** Whether the endpoint saves the message for the watches. */
export async function watchEligible(message: AgentMessage, deps: Pick<WatchDeps, "watchers">): Promise<boolean> {
  if (!watchable(message)) return false;
  return hearing(message, await deps.watchers(message.teamId, message.channel)).length > 0;
}

/** Whether the message is Outrunner's own. */
async function ownOutput(message: AgentMessage, deps: Pick<WatchDeps, "self">): Promise<boolean> {
  const self = await deps.self(message.teamId);
  return message.user === self.userId || (message.botId !== null && message.botId !== undefined && message.botId === self.botId);
}

/** Run the watches a saved message reaches: one run each (its key the
 *  message), each started (its filter, its request). How many ran. Throws
 *  when the runs couldn't be recorded: the saved message is tried again. */
export async function processWatchedMessage(message: AgentMessage, deps: WatchDeps): Promise<number> {
  if (!watchable(message)) return 0;
  if (await ownOutput(message, deps)) return 0;
  const watchers = hearing(message, await deps.watchers(message.teamId, message.channel));
  if (watchers.length === 0) return 0;
  const candidates = (await deps.candidates(watchers.map((w) => w.automationId))).filter(
    (c) =>
      c.target?.kind === "mission" &&
      c.triggers.includes("slack.message") &&
      c.target.watch?.teamId === message.teamId &&
      c.target.watch.channelId === message.channel,
  );
  if (candidates.length === 0) return 0;
  const event: SlackWatchEvent = {
    trigger: "slack.message",
    teamId: message.teamId,
    channelId: message.channel,
    ts: message.ts,
    user: message.user,
    botId: message.botId ?? null,
    appId: message.appId ?? null,
    author: message.botId ? null : await deps.name(message.teamId, message.user).catch(() => null),
    text: message.text.slice(0, 8000),
    permalink: await deps.permalink(message.teamId, message.channel, message.ts).catch(() => null),
  };
  const key = `slack:${message.teamId}:${message.channel}:${message.ts}`;
  const recorded = await deps.recordRuns(candidates.map((c) => recordOf(c, event, key)));
  const runs: PendingRun[] = candidates.flatMap((candidate) => {
    const run = recorded.get(`${candidate.automationId}:${candidate.projectId}`);
    return run ? [{ runId: run.runId, candidate, event, ...(run.queued ? { queued: true } : {}) }] : [];
  });
  for (const run of runs) await deps.startRun(run);
  return runs.length;
}
