/**
 * The Slack agent speaking first, the parts with no network or database:
 * when a channel's digest is due and what it says, the nudge for an item
 * waiting in triage, reading the validator's verdict on a pull request, what
 * a session is told when its work is sent back, and the watch mode's check of
 * whether a message is work to file. lib/slack/proactive.ts runs them.
 */

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The date (YYYY-MM-DD), hour and weekday (0 = Sunday) at `now` in `tz`. */
export function localTime(now: Date, tz: string): { date: string; hour: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: isTimeZone(tz) ? tz : "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, weekday: weekdays.indexOf(parts.weekday) };
}

export type DigestSchedule = { digest: "daily" | "weekly" | null; hour: number; tz: string; lastSentOn: string | null };

/**
 * Whether a channel's digest goes out now: in its hour, local time (a weekly
 * one on Mondays), and not already today. The cron runs every 2 minutes, so
 * the hour is the window; one missed entirely waits for the next day.
 */
export function digestDue(schedule: DigestSchedule, now: Date): string | null {
  if (!schedule.digest) return null;
  const local = localTime(now, schedule.tz);
  if (local.hour !== schedule.hour || schedule.lastSentOn === local.date) return null;
  if (schedule.digest === "weekly" && local.weekday !== 1) return null;
  return local.date;
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

export type DigestData = {
  orgName: string;
  period: "daily" | "weekly";
  shipped: { repo: string; number: number; title: string; url: string }[];
  inProgress: { key: string; title: string; url: string }[];
  waiting: { key: string; title: string; url: string; days: number }[];
  stuck: { key: string; title: string; url: string; days: number }[];
};

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function list<T>(rows: T[], line: (row: T) => string, max = 8): string {
  const shown = rows.slice(0, max).map((r) => `• ${line(r)}`);
  if (rows.length > max) shown.push(`• …and ${rows.length - max} more`);
  return shown.join("\n");
}

/** The digest, in Slack's markup; null when there's nothing to say. */
export function digestText(data: DigestData): string | null {
  const sections: string[] = [];
  const since = data.period === "daily" ? "since yesterday" : "this week";
  if (data.shipped.length) {
    sections.push(`*Shipped ${since}* (${data.shipped.length})\n${list(data.shipped, (p) => `<${p.url}|#${p.number} ${esc(p.title)}> · ${p.repo}`)}`);
  }
  if (data.inProgress.length) {
    sections.push(`*In progress* (${data.inProgress.length})\n${list(data.inProgress, (i) => `<${i.url}|${i.key}> ${esc(i.title)}`)}`);
  }
  if (data.stuck.length) {
    sections.push(
      `*Stuck: in progress with no pull request* (${data.stuck.length})\n${list(data.stuck, (i) => `<${i.url}|${i.key}> ${esc(i.title)} · ${i.days}d`)}`,
    );
  }
  if (data.waiting.length) {
    sections.push(
      `*Waiting in triage* (${data.waiting.length})\n${list(data.waiting, (i) => `<${i.url}|${i.key}> ${esc(i.title)} · ${i.days}d`)}`,
    );
  }
  if (sections.length === 0) return null;
  return [`*${esc(data.orgName)}: ${data.period === "daily" ? "daily" : "weekly"} digest*`, ...sections].join("\n\n");
}

/** The DM to whoever filed an item that has waited in triage. */
export function nudgeText(item: { key: string; title: string; url: string; days: number }): string {
  return `<${item.url}|${item.key}> ${esc(item.title)} has waited in triage for ${item.days === 1 ? "a day" : `${item.days} days`}. Accept it, decline it, or give it a workspace so it can be picked up.`;
}

// ---------------------------------------------------------------------------
// Validator verdicts
// ---------------------------------------------------------------------------

export type Verdict = "PASS" | "FAIL" | "PARTIAL";

/** The verdict a validator's comment gives ("Verdict: FAIL ..."), or null for
 *  any other comment. */
export function parseVerdict(body: string): Verdict | null {
  const match = /^\s*\**\s*Verdict\s*\**\s*:\s*\**\s*(PASS|FAIL|PARTIAL)\b/im.exec(body);
  return match ? (match[1].toUpperCase() as Verdict) : null;
}

/** The verdict comment, cut for the thread. */
export function verdictExcerpt(body: string, max = 1500): string {
  const text = body.trim();
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/** What the item's session is told when its work is sent back. */
export function sendBackPrompt(itemKey: string, verdictComment: string): string {
  return `The validator checked your pull request for ${itemKey} against its acceptance criteria and posted this:

${verdictComment.trim()}

Fix what it found not met (and check what it couldn't), push to the same branch so the pull request updates, and update the checklist in its description, saying how you checked each criterion.`;
}

// ---------------------------------------------------------------------------
// Watching a channel
// ---------------------------------------------------------------------------

export type Classification = { kind: "bug" | "request" | "none"; summary: string };

export const CLASSIFIER_PROMPT = `You watch a team's Slack channel for messages that report a bug or ask for something to be built or changed in their software. Decide for one message:
- "bug": it reports something broken, an error, or unexpected behaviour.
- "request": it asks for a feature, a change, or an improvement.
- "none": anything else (chat, questions, status updates, links, thanks, announcements). When unsure, say "none".
Answer with JSON only: {"kind": "bug" | "request" | "none", "summary": "a short imperative title, empty for none"}.`;

/** The classifier's answer, checked; anything unclear is "none". */
export function parseClassification(raw: string): Classification {
  try {
    const data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as { kind?: unknown; summary?: unknown };
    const kind = data.kind === "bug" || data.kind === "request" ? data.kind : "none";
    const summary = typeof data.summary === "string" ? data.summary.trim().slice(0, 150) : "";
    return kind === "none" || !summary ? { kind: "none", summary: "" } : { kind, summary };
  } catch {
    return { kind: "none", summary: "" };
  }
}

/** Action ids of the buttons the agent posts on its own. */
export const PROACTIVE_ACTIONS = {
  watchFile: "watch_file",
  watchDismiss: "watch_dismiss",
  sendBack: "verdict_send_back",
  leave: "verdict_leave",
} as const;

type Block = Record<string, unknown>;

/** The offer under a watched message that looks like work. */
export function watchOffer(classification: Classification, value: string): Block[] {
  const what = classification.kind === "bug" ? "a bug report" : "a request";
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `This looks like ${what}: *${esc(classification.summary)}*. Want me to write it up for triage?` },
    },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: PROACTIVE_ACTIONS.watchFile, style: "primary", text: { type: "plain_text", text: "Yes, write it up" }, value },
        { type: "button", action_id: PROACTIVE_ACTIONS.watchDismiss, text: { type: "plain_text", text: "No thanks" }, value },
      ],
    },
  ];
}

/** The validator's verdict in the item's thread, with what can be done
 *  about one that isn't a pass. */
export function verdictBlocks(input: { itemKey: string; verdict: Verdict; url: string; excerpt: string; conversationId: string }): Block[] {
  const blocks: Block[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        // The comment is model output shaped by the PR: escaped, so it can't
        // ping the channel or break the markup.
        text: `The validator checked <${input.url}|${input.itemKey}'s pull request>: *${input.verdict}*\n${esc(input.excerpt.slice(0, 2800))}`,
      },
    },
  ];
  if (input.verdict !== "PASS") {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: PROACTIVE_ACTIONS.sendBack,
          style: "primary",
          text: { type: "plain_text", text: "Send back to the session" },
          value: input.conversationId,
        },
        { type: "button", action_id: PROACTIVE_ACTIONS.leave, text: { type: "plain_text", text: "Leave it" }, value: input.conversationId },
      ],
    });
  }
  return blocks;
}
