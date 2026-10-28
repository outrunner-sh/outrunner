/**
 * The Slack agent speaking first, run on the cron's tick (every 2 minutes,
 * POST /api/integrations/slack/tick):
 *
 *   digests    - in channels that asked for one, at their hour, local time
 *   nudges     - a DM to whoever filed an item that has waited in triage a day
 *   follow-ups - in an item's thread: the validator's verdict on its PR (with
 *                "send back to the session" when it isn't a pass), and the
 *                merge, which closes the item
 *
 * Each part is bounded per tick and logged, never thrown: one failing doesn't
 * keep the others from running.
 */

import { getOrg } from "@/lib/db/orgs";
import {
  claimPullRequestEnd,
  claimVerdict,
  conversationsWithOpenPullRequests,
  getInstallation,
  sessionSummary,
  type SlackConversation,
} from "@/lib/db/slack-agent";
import { type ChannelSettings, claimDigest, digestChannels, releaseDigest } from "@/lib/db/slack-channels";
import { listWorkItems, triageActor } from "@/lib/db/work-items";
import { appSlug, githubAppConfig } from "@/lib/github/app";
import { githubGet, repoToken } from "@/lib/slack/github";
import { mergedPulls } from "@/lib/slack/lookups";
import {
  digestDue,
  digestText,
  nudgeText,
  parseVerdict,
  verdictBlocks,
  verdictExcerpt,
} from "@/lib/slack/proactive-text";
import { relayAwaited } from "@/lib/slack/relay";
import { addReaction, postMessage, removeReaction } from "@/lib/slack/web";
import { archiveServerSessions } from "@/lib/session/server-session";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { itemUrl } from "@/lib/triage/urls";
import { isOpen, itemKey } from "@/lib/triage/work-items";

const DAY_MS = 24 * 60 * 60 * 1000;
/** In progress this long with no pull request is stuck. */
const STUCK_DAYS = 3;

function daysSince(iso: string | null, now: Date): number {
  return iso ? Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS)) : 0;
}

async function quietly<T>(label: string, work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    console.error(`Slack agent tick: ${label} failed`, error);
    return null;
  }
}

/** One tick: what went out. */
export async function runTick(now = new Date()): Promise<{ digests: number; nudges: number; followUps: number; replies: number }> {
  const [digests, nudges, followUps, replies] = await Promise.all([
    quietly("digests", () => sendDueDigests(now)),
    quietly("nudges", () => nudgeWaitingItems(now)),
    quietly("follow-ups", () => followUpPullRequests()),
    // Threads' sessions' replies still awaited, for turns that outlast the
    // watch right after a send (lib/slack/relay.ts).
    quietly("replies", () => relayAwaited()),
  ]);
  return { digests: digests ?? 0, nudges: nudges ?? 0, followUps: followUps ?? 0, replies: replies ?? 0 };
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

async function sendDueDigests(now: Date): Promise<number> {
  let sent = 0;
  for (const channel of await digestChannels()) {
    const date = digestDue(
      { digest: channel.digest, hour: channel.digestHour, tz: channel.digestTz, lastSentOn: channel.lastDigestOn },
      now,
    );
    if (!date || !(await claimDigest(channel.teamId, channel.channelId, date))) continue;
    if (await quietly(`digest for ${channel.channelId}`, () => sendDigest(channel, now))) {
      sent++;
    } else {
      // Not sent (Slack failed, or no one to send it as): the next tick in the
      // hour tries again.
      console.error(`Slack agent: the digest for ${channel.channelId} didn't go out`);
      await releaseDigest(channel.teamId, channel.channelId, channel.lastDigestOn).catch(() => undefined);
    }
  }
  return sent;
}

/**
 * A channel's digest: what shipped, what's in progress or stuck, and what
 * waits in triage, as the person who set it up may see it.
 */
export async function sendDigest(channel: ChannelSettings, now = new Date()): Promise<boolean> {
  const install = await getInstallation(channel.teamId);
  const actor = channel.setBy ? await triageActor(channel.setBy, channel.orgId) : null;
  if (!install || !actor) return false;
  const period = channel.digest ?? "daily";
  const [org, recent, items] = await Promise.all([
    getOrg(channel.orgId),
    mergedPulls(actor, { days: period === "daily" ? 1 : 7 }),
    listWorkItems(actor),
  ]);
  const shipped = recent.merged.map((p) => ({ repo: p.repo, number: p.number, title: p.title, url: p.url }));

  const inProgress = items.filter((i) => i.status === "in_progress");
  const db = createSupabaseAdminClient();
  const sessions = inProgress.flatMap((i) => (i.workspaceId ? [i.workspaceId] : []));
  const { data: pulls } = sessions.length
    ? await db.from("pull_requests").select("workspace_id").in("workspace_id", sessions)
    : { data: [] };
  const { data: threads } = inProgress.length
    ? await db.from("slack_conversations").select("item_id").in("item_id", inProgress.map((i) => i.id)).not("pr_number", "is", null)
    : { data: [] };
  const withPull = new Set([...(pulls ?? []).map((p) => p.workspace_id), ...(threads ?? []).map((t) => t.item_id)]);
  const row = (i: (typeof items)[number]) => ({ key: itemKey(i), title: i.title, url: itemUrl(i) });
  const stuck = inProgress.filter(
    (i) => !withPull.has(i.workspaceId ?? "") && !withPull.has(i.id) && daysSince(i.updatedAt, now) >= STUCK_DAYS,
  );

  const text = digestText({
    orgName: org?.name ?? "Outrunner",
    period,
    shipped,
    inProgress: inProgress.filter((i) => !stuck.includes(i)).map(row),
    stuck: stuck.map((i) => ({ ...row(i), days: daysSince(i.updatedAt, now) })),
    waiting: items
      .filter((i) => i.status === "triage")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((i) => ({ ...row(i), days: daysSince(i.createdAt, now) })),
  });
  await postMessage(install.botToken, {
    channel: channel.channelId,
    text: text ?? `Nothing shipped ${period === "daily" ? "since yesterday" : "this week"}, and nothing waits in triage.`,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Nudges
// ---------------------------------------------------------------------------

/** A DM, once, to whoever filed an item that has waited in triage a day:
 *  when their Slack account is connected in that org. */
async function nudgeWaitingItems(now: Date): Promise<number> {
  const db = createSupabaseAdminClient();
  const { data: items, error } = await db
    .from("work_items")
    .select("id, org_id, number, title, created_by, created_at")
    .eq("status", "triage")
    .is("slack_nudged_at", null)
    .not("created_by", "is", null)
    .lt("created_at", new Date(now.getTime() - DAY_MS).toISOString())
    .limit(20);
  if (error) throw error;
  let sent = 0;
  for (const item of items ?? []) {
    // Claimed before anything is sent, and only if no other tick has: one DM
    // at most, whether or not there's anyone to tell.
    const { data: claimed, error: claimError } = await db
      .from("work_items")
      .update({ slack_nudged_at: now.toISOString() })
      .eq("id", item.id)
      .is("slack_nudged_at", null)
      .select("id");
    if (claimError) throw claimError;
    if (!claimed?.length) continue;
    const { data: link } = await db
      .from("slack_links")
      .select("team_id, slack_user_id")
      .eq("owner_id", item.created_by as string)
      .eq("org_id", item.org_id)
      .limit(1)
      .maybeSingle();
    if (!link) continue;
    const install = await getInstallation(link.team_id);
    if (!install) continue;
    const text = nudgeText({
      key: `OR-${item.number}`,
      title: item.title,
      url: itemUrl({ id: item.id }),
      days: daysSince(item.created_at, now),
    });
    // To the person: the app's DM with them.
    if (await quietly(`nudge for OR-${item.number}`, () => postMessage(install.botToken, { channel: link.slack_user_id, text }))) sent++;
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

type Comment = { id: number; body?: string | null; user?: { type?: string; login?: string } | null };
type Pull = { merged_at: string | null; state: string };

/** The validator's newest verdict on a pull request, if one was posted after
 *  `afterId`. Only a bot's comment (the App's) counts. */
export async function newVerdict(
  token: string,
  pr: { repo: string; number: number },
  afterId: number | null,
): Promise<{ id: number; body: string; verdict: NonNullable<ReturnType<typeof parseVerdict>> } | null> {
  // Newest first: the validator runs again on every push.
  const comments = await githubGet<Comment[]>(
    token,
    `/repos/${pr.repo}/issues/${pr.number}/comments?sort=created&direction=desc&per_page=50`,
  );
  // The Outrunner App's own comments, where its name is known; else any bot's.
  const config = githubAppConfig();
  const slug = config ? await appSlug(config) : null;
  const fromValidator = (c: Comment) => (slug ? c.user?.login === `${slug}[bot]` : c.user?.type === "Bot");
  for (const c of comments ?? []) {
    if (afterId !== null && c.id <= afterId) break;
    const verdict = fromValidator(c) && c.body ? parseVerdict(c.body) : null;
    if (verdict && c.body) return { id: c.id, body: c.body, verdict };
  }
  return null;
}

async function followUpPullRequests(): Promise<number> {
  let posted = 0;
  for (const conversation of await conversationsWithOpenPullRequests()) {
    if (await quietly(`follow-up for ${conversation.id}`, () => followUp(conversation))) posted++;
  }
  return posted;
}

/** One thread's pull request: its newest verdict, and whether it's merged. */
async function followUp(conversation: SlackConversation): Promise<boolean> {
  const pr = conversation.pr;
  if (!pr || !conversation.itemId) return false;
  const install = await getInstallation(conversation.teamId);
  const token = await repoToken(conversation.orgId, pr.repo);
  if (!install || !token) return false;
  const db = createSupabaseAdminClient();
  const { data: item } = await db
    .from("work_items")
    .select("id, number, status, triaged_at")
    .eq("id", conversation.itemId)
    .maybeSingle();
  if (!item) return false;
  const key = `OR-${item.number}`;
  const where = { channel: conversation.channelId, threadTs: conversation.threadTs };
  let posted = false;

  const verdict = await newVerdict(token, pr, conversation.verdictCommentId);
  // Claimed first: an overlapping tick that found the same one posts nothing.
  if (verdict && (await claimVerdict(conversation.id, verdict.id))) {
    await postMessage(install.botToken, {
      ...where,
      text: `The validator says ${verdict.verdict} on ${key}.`,
      blocks: verdictBlocks({ itemKey: key, verdict: verdict.verdict, url: pr.url, excerpt: verdictExcerpt(verdict.body), conversationId: conversation.id }),
    });
    posted = true;
  }

  const pull = await githubGet<Pull>(token, `/repos/${pr.repo}/pulls/${pr.number}`);
  if (pull?.merged_at && (await claimPullRequestEnd(conversation.id))) {
    // Merged is done, for an item still open: one someone declined or marked a
    // duplicate meanwhile stays as they left it.
    if (isOpen(item.status)) {
      await db
        .from("work_items")
        .update({ status: "done", duplicate_of: null, ...(item.triaged_at ? {} : { triaged_at: new Date().toISOString() }) })
        .eq("id", item.id);
      await postMessage(install.botToken, { ...where, text: `<${pr.url}|The pull request> is merged, so ${key} is done.` });
    } else {
      await postMessage(install.botToken, { ...where, text: `<${pr.url}|The pull request> for ${key} is merged.` });
    }
    // Its work is in: the session is archived (🗃️). A reply in the thread
    // restores it.
    const session = await threadSession(conversation);
    if (session && (await archiveServerSessions(session.ownerId, [session.id])) > 0) {
      const root = { channel: conversation.channelId, ts: conversation.threadTs };
      await removeReaction(install.botToken, { ...root, name: "eyes" }).catch(() => undefined);
      await addReaction(install.botToken, { ...root, name: "card_file_box" }).catch(() => undefined);
    }
    posted = true;
  } else if (pull && !pull.merged_at && pull.state === "closed" && (await claimPullRequestEnd(conversation.id))) {
    await postMessage(install.botToken, { ...where, text: `<${pr.url}|The pull request> for ${key} was closed without merging. ${key} stays open.` });
    posted = true;
  }
  return posted;
}

/** The session behind a thread, and who it belongs to. */
export async function threadSession(conversation: SlackConversation): Promise<{ id: string; ownerId: string } | null> {
  if (!conversation.workspaceId) return null;
  const session = await sessionSummary(conversation.workspaceId).catch(() => null);
  return session ? { id: session.id, ownerId: session.ownerId } : null;
}
