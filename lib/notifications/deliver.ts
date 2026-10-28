/**
 * Notifications by email and Slack, from the sessions tick: each one on its
 * own (instant email, a Slack DM), past a minute's grace and only if the user
 * hasn't looked at the session since, and once a day a digest for those who
 * chose it. The browser shows them as they come
 * (hooks/use-notifications.ts); this is for when the user isn't there.
 */

import { getInstallation } from "@/lib/db/slack-agent";
import { people } from "@/lib/db/org-members";
import { preferencesOf } from "@/lib/db/notification-preferences";
import { optionalEnv } from "@/lib/env";
import { canSendEmail, sendEmail } from "@/lib/email/send";
import { dueFor, isNotificationKind, type NotificationKind } from "@/lib/notifications/events";
import { digestEmail, instantEmail, slackMessage, type SentNotification } from "@/lib/notifications/messages";
import { postMessage } from "@/lib/slack/web";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** Older than this and not yet handled, a notification is let go of: an
 *  email about an hour-old turn is noise. */
const DELIVER_WITHIN_MS = 60 * 60_000;
/** A digest is sent at most this often. */
const DIGEST_EVERY_MS = 24 * 60 * 60_000;
/** A digest that couldn't be sent is tried again this much later: soon
 *  enough for a hiccup, rare enough for an address that never works. */
const DIGEST_RETRY_MS = 60 * 60_000;
/** Ids a write names at most: they all go in its URL. */
const LET_GO_CHUNK = 100;

function db() {
  return createSupabaseAdminClient();
}

function base(): string {
  return optionalEnv("RUNTIME_BASE_URL") ?? "https://app.outrunner.sh";
}

type Row = {
  id: string;
  user_id: string;
  workspace_id: string;
  kind: string;
  title: string;
  body: string;
  created_at: string;
  emailed_at: string | null;
  slacked_at: string | null;
};

function toSent(row: Row): SentNotification | null {
  if (!isNotificationKind(row.kind)) return null;
  return { workspaceId: row.workspace_id, kind: row.kind as NotificationKind, title: row.title, body: row.body, createdAt: row.created_at };
}

/** When each of these users last saw each of these sessions. */
async function seenAt(rows: Row[]): Promise<Map<string, string | null>> {
  const seen = new Map<string, string | null>();
  if (rows.length === 0) return seen;
  const { data, error } = await db()
    .from("session_marks")
    .select("user_id, workspace_id, seen_at")
    .in("user_id", [...new Set(rows.map((r) => r.user_id))])
    .in("workspace_id", [...new Set(rows.map((r) => r.workspace_id))]);
  if (error) throw error;
  for (const mark of data ?? []) seen.set(`${mark.user_id}:${mark.workspace_id}`, mark.seen_at);
  return seen;
}

/** The DM channel (the Slack user) and bot token for each user with Slack
 *  linked: their first link. */
async function slackTargets(userIds: string[]): Promise<Map<string, { channel: string; token: string }>> {
  const targets = new Map<string, { channel: string; token: string }>();
  if (userIds.length === 0) return targets;
  const { data, error } = await db()
    .from("slack_links")
    .select("owner_id, team_id, slack_user_id, created_at")
    .in("owner_id", userIds)
    .order("created_at", { ascending: true });
  if (error) throw error;
  for (const link of data ?? []) {
    if (targets.has(link.owner_id)) continue;
    const install = await getInstallation(link.team_id).catch(() => null);
    if (install) targets.set(link.owner_id, { channel: link.slack_user_id, token: install.botToken });
  }
  return targets;
}

/** Claim a notification for one channel: true when this call set it, false
 *  when another got there first. */
async function claimFor(id: string, channel: "emailed_at" | "slacked_at", stamp: string): Promise<boolean> {
  const { data, error } = await db()
    .from("session_notifications")
    .update(channel === "emailed_at" ? { emailed_at: stamp } : { slacked_at: stamp })
    .eq("id", id)
    .is(channel, null)
    .select("id");
  if (error) throw error;
  return Boolean(data?.length);
}

export type DeliveryReport = { emailed: number; slacked: number; digests: number };

/** Instant email and Slack DMs for what's due, then digests. */
export async function deliverNotifications(now: number = Date.now()): Promise<DeliveryReport> {
  const report: DeliveryReport = { emailed: 0, slacked: 0, digests: 0 };
  const since = new Date(now - DELIVER_WITHIN_MS).toISOString();
  const { data, error } = await db()
    .from("session_notifications")
    .select("id, user_id, workspace_id, kind, title, body, created_at, emailed_at, slacked_at")
    .gt("created_at", since)
    .or("emailed_at.is.null,slacked_at.is.null")
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  if (rows.length > 0) {
    const userIds = [...new Set(rows.map((r) => r.user_id))];
    const [preferences, seen, who] = await Promise.all([preferencesOf(userIds), seenAt(rows), people(userIds).catch(() => new Map())]);
    const slackUsers = userIds.filter((id) => preferences.get(id)?.slack);
    const slack = await slackTargets(slackUsers);
    const emailOn = canSendEmail();
    const stamp = new Date(now).toISOString();
    // Rows a channel won't carry (off, seen, a digest's, no address or
    // Slack link) are let go of in one write a channel; only those it sends
    // are claimed one by one (its stamp set where it was null), so two ticks
    // at once send once.
    const letGo: Record<"emailed_at" | "slacked_at", string[]> = { emailed_at: [], slacked_at: [] };
    const sends: Array<() => Promise<void>> = [];
    for (const row of rows) {
      const sent = toSent(row);
      const prefs = preferences.get(row.user_id);
      if (!sent || !prefs) continue;
      const due = dueFor(sent, prefs, seen.get(`${row.user_id}:${row.workspace_id}`) ?? null, now);
      if (due === "wait") continue;
      if (row.emailed_at === null) {
        const email = who.get(row.user_id)?.email;
        if (due === "send" && prefs.email === "instant" && emailOn && email) {
          sends.push(async () => {
            if (!(await claimFor(row.id, "emailed_at", stamp))) return;
            if (await sendEmail({ to: [email], ...instantEmail(sent, base()) })) report.emailed++;
          });
        } else letGo.emailed_at.push(row.id);
      }
      if (row.slacked_at === null) {
        const target = slack.get(row.user_id);
        if (due === "send" && prefs.slack && target) {
          sends.push(async () => {
            if (!(await claimFor(row.id, "slacked_at", stamp))) return;
            const ok = await postMessage(target.token, { channel: target.channel, text: slackMessage(sent, base()) })
              .then(() => true)
              .catch((slackError: unknown) => {
                console.error(`Notifications: couldn't DM ${row.user_id} on Slack`, slackError);
                return false;
              });
            if (ok) report.slacked++;
          });
        } else letGo.slacked_at.push(row.id);
      }
    }
    for (const channel of ["emailed_at", "slacked_at"] as const) {
      // In chunks: every id goes in the request's URL.
      for (let i = 0; i < letGo[channel].length; i += LET_GO_CHUNK) {
        const { error: letGoError } = await db()
          .from("session_notifications")
          .update(channel === "emailed_at" ? { emailed_at: stamp } : { slacked_at: stamp })
          .in("id", letGo[channel].slice(i, i + LET_GO_CHUNK))
          .is(channel, null);
        if (letGoError) throw letGoError;
      }
    }
    for (const send of sends) await send();
  }
  report.digests = await deliverDigests(now);
  return report;
}

/**
 * The daily digest, for those who chose it: what happened in their sessions
 * since the last one (a day at most) that they haven't looked at since. A day
 * with none sends nothing, and the next is a day on.
 */
export async function deliverDigests(now: number = Date.now()): Promise<number> {
  if (!canSendEmail()) return 0;
  const cutoff = new Date(now - DIGEST_EVERY_MS).toISOString();
  const { data, error } = await db()
    .from("notification_preferences")
    .select("user_id, digest_sent_at")
    .eq("email", "digest")
    .or(`digest_sent_at.is.null,digest_sent_at.lt.${cutoff}`)
    // Not one waiting to try again after a failure.
    .or(`digest_retry_at.is.null,digest_retry_at.lt.${new Date(now).toISOString()}`)
    // Longest waiting first. One that keeps failing stays oldest, but the
    // retry filter above keeps it out between tries, so it can't crowd others.
    .order("digest_sent_at", { ascending: true, nullsFirst: true })
    .limit(50);
  if (error) throw error;
  let sent = 0;
  for (const user of data ?? []) {
    const stamp = new Date(now).toISOString();
    // Claimed first: two ticks at once send one digest.
    let claim = db().from("notification_preferences").update({ digest_sent_at: stamp, digest_retry_at: null }).eq("user_id", user.user_id);
    claim = user.digest_sent_at === null ? claim.is("digest_sent_at", null) : claim.eq("digest_sent_at", user.digest_sent_at);
    const { data: claimed, error: claimError } = await claim.select("user_id");
    if (claimError) throw claimError;
    if (!claimed?.length) continue;

    // Since the last digest, so a retry covers what the failed one would
    // have; at most two days back, which is also where a first digest (and
    // its retry) starts.
    const last = user.digest_sent_at ? Date.parse(user.digest_sent_at) : 0;
    const from = new Date(Math.max(last, now - 2 * DIGEST_EVERY_MS)).toISOString();
    const { data: rows, error: rowsError } = await db()
      .from("session_notifications")
      .select("id, user_id, workspace_id, kind, title, body, created_at, emailed_at, slacked_at")
      .eq("user_id", user.user_id)
      .gt("created_at", from)
      .order("created_at", { ascending: false })
      .limit(100);
    if (rowsError) throw rowsError;
    const [prefs, seen] = await Promise.all([preferencesOf([user.user_id]), seenAt((rows ?? []) as Row[])]);
    const kinds = prefs.get(user.user_id)?.kinds ?? [];
    const news = ((rows ?? []) as Row[])
      .filter((row) => {
        const at = seen.get(`${row.user_id}:${row.workspace_id}`);
        return isNotificationKind(row.kind) && kinds.includes(row.kind) && !(at && Date.parse(at) >= Date.parse(row.created_at));
      })
      .map(toSent)
      .filter((n): n is SentNotification => n !== null);
    if (news.length === 0) continue;
    const email = (await people([user.user_id]).catch(() => new Map())).get(user.user_id)?.email;
    if (email && (await sendEmail({ to: [email], ...digestEmail(news, base()) }))) {
      sent++;
      continue;
    }
    // Not sent (no address read, or the email refused): the claim is given
    // back where it's still ours, digest_sent_at as it was, so the retry
    // reads the same window; and it waits an hour, not retried every tick for
    // an address that never works.
    const { error: releaseError } = await db()
      .from("notification_preferences")
      .update({ digest_sent_at: user.digest_sent_at, digest_retry_at: new Date(now + DIGEST_RETRY_MS).toISOString() })
      .eq("user_id", user.user_id)
      .eq("digest_sent_at", stamp);
    if (releaseError) throw releaseError;
  }
  return sent;
}
