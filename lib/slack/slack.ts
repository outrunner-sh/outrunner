import { createHmac, timingSafeEqual } from "node:crypto";

import { titleFromText } from "@/lib/triage/work-items";

/**
 * Slack, the parts with no database or network: checking that a request came
 * from Slack, the link that connects a Slack user to their Outrunner account,
 * and how a message or a `/triage` command becomes a triage capture.
 * app/api/integrations/slack/route.ts is the endpoint; docs/slack-app.md sets
 * the Slack app up.
 */

/** How far a request's timestamp may be from now: Slack's own advice, so a
 *  captured request can't be replayed later. */
const MAX_SKEW_SECONDS = 5 * 60;

/**
 * Whether a request is Slack's: `X-Slack-Signature` is `v0=` and the
 * HMAC-SHA256, under the app's signing secret, of `v0:<timestamp>:<raw body>`.
 */
export function verifySlackSignature(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowSeconds?: number;
}): boolean {
  const { secret, timestamp, signature, body } = input;
  if (!secret || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** The Slack user a link is for, as Slack named them when they asked. */
export type SlackIdentity = {
  teamId: string;
  teamName: string | null;
  userId: string;
  userName: string | null;
};

/** How long the link Slack hands a user stays good. */
export const LINK_TTL_MS = 10 * 60 * 1000;

const ID_PATTERN = /^[A-Z0-9]{2,32}$/;

function linkSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`slack-link:${payload}`).digest("base64url");
}

/**
 * The token in the link that connects a Slack user to whoever opens it signed
 * in. Signed with the app's signing secret, so only a reply from this endpoint
 * (shown to that Slack user alone) can have made one, and it expires.
 */
export function signLinkToken(identity: SlackIdentity, secret: string, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({
      t: identity.teamId,
      tn: identity.teamName,
      u: identity.userId,
      un: identity.userName,
      exp: now + LINK_TTL_MS,
    }),
  ).toString("base64url");
  return `${payload}.${linkSignature(payload, secret)}`;
}

/** The identity a link's token names, or null for a forged, broken or
 *  expired one. */
export function verifyLinkToken(token: string, secret: string, now = Date.now()): SlackIdentity | null {
  if (!secret || typeof token !== "string" || token.length > 2000) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const given = Buffer.from(signature);
  const wanted = Buffer.from(linkSignature(payload, secret));
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const data = raw as { t?: unknown; tn?: unknown; u?: unknown; un?: unknown; exp?: unknown };
  if (typeof data.t !== "string" || !ID_PATTERN.test(data.t)) return null;
  if (typeof data.u !== "string" || !ID_PATTERN.test(data.u)) return null;
  if (typeof data.exp !== "number" || data.exp < now) return null;
  return {
    teamId: data.t,
    teamName: typeof data.tn === "string" ? data.tn.slice(0, 200) : null,
    userId: data.u,
    userName: typeof data.un === "string" ? data.un.slice(0, 200) : null,
  };
}

/**
 * Slack's message markup as Markdown: links, mentions and channels unwrapped,
 * *bold* and ~strike~ in Markdown's spelling, and the three escapes Slack
 * makes undone. Code spans and blocks are left as they are.
 */
export function slackToMarkdown(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return unescapeSlack(part);
      return unescapeSlack(
        part
          .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, "[$2]($1)")
          .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
          .replace(/<@([A-Z0-9]+)\|([^>]+)>/g, "@$2")
          .replace(/<@([A-Z0-9]+)>/g, "@$1")
          .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
          .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
          .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, "$1")
          .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1**$2**")
          .replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?:;]|$)/g, "$1~~$2~~"),
      );
    })
    .join("");
}

function unescapeSlack(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** A message's link: Slack's own pattern, from the payload alone (no token). */
export function slackPermalink(input: {
  teamDomain: string | null;
  channelId: string;
  ts: string;
  threadTs?: string | null;
}): string | null {
  const { teamDomain, channelId, ts, threadTs } = input;
  if (!teamDomain || !/^[a-z0-9-]+$/i.test(teamDomain)) return null;
  if (!ID_PATTERN.test(channelId) || !/^\d+\.\d+$/.test(ts)) return null;
  const base = `https://${teamDomain}.slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts && /^\d+\.\d+$/.test(threadTs)
    ? `${base}?thread_ts=${threadTs}&cid=${channelId}`
    : base;
}

/** What a capture from Slack makes, before it is stored. */
export type SlackCapture = {
  title: string;
  body: string;
  /** `owner/name` the command named first; resolved by the caller. */
  project: string | null;
  sourceUrl: string | null;
  sourceRef: string | null;
  author: string | null;
};

/** The message shortcut's payload (`type: "message_action"`), as read. */
export type MessageAction = {
  team: { id: string; domain?: string | null };
  user: { id: string; name?: string | null; username?: string | null };
  channel: { id: string; name?: string | null };
  message: {
    ts: string;
    thread_ts?: string | null;
    text?: string | null;
    user?: string | null;
    user_profile?: { display_name?: string | null; real_name?: string | null; name?: string | null } | null;
  };
  response_url: string;
};

/**
 * "Send to Outrunner triage" on a message: its first line is the title, the
 * whole message (as Markdown) the body, with who said it where and a link
 * back. Every message of a thread shares the thread's ref, so a second one
 * from the same thread becomes a note on the first's item.
 */
export function captureFromMessage(action: MessageAction): SlackCapture {
  const text = slackToMarkdown(action.message.text ?? "").trim();
  const profile = action.message.user_profile;
  const author =
    profile?.display_name || profile?.real_name || profile?.name || (action.message.user ? `<@${action.message.user}>` : null);
  const where = action.channel.name ? `#${action.channel.name}` : "Slack";
  const permalink = slackPermalink({
    teamDomain: action.team.domain ?? null,
    channelId: action.channel.id,
    ts: action.message.ts,
    threadTs: action.message.thread_ts,
  });
  const thread = action.message.thread_ts || action.message.ts;
  const credit = `— ${author ? `${author} in ` : ""}${where}${permalink ? ` · [View in Slack](${permalink})` : ""}`;
  return {
    title: titleFromText(text) || `Message in ${where}`,
    body: text ? `${text}\n\n${credit}` : credit,
    project: null,
    sourceUrl: permalink,
    sourceRef: `slack:${action.team.id}/${action.channel.id}/${thread}`,
    author: author ? `${author} (${where})` : where,
  };
}

/**
 * `/triage [owner/repo] <text>`: the text is the item. A first word shaped
 * like `owner/repo` names its workspace (the caller checks it's one of the
 * user's, and files the item Unsorted, keeping that word, if not). Nothing to
 * capture is null.
 */
export function parseTriageCommand(text: string): { project: string | null; text: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s+([\s\S]+)$/.exec(trimmed);
  if (match) return { project: match[1], text: match[2].trim() };
  return { project: null, text: trimmed };
}

/** The capture a `/triage` command makes. Commands aren't deduplicated: each
 *  is its own item. */
export function captureFromCommand(
  text: string,
  meta: { channelName: string | null; userName: string | null },
): SlackCapture {
  const markdown = slackToMarkdown(text).trim();
  const where = meta.channelName && meta.channelName !== "directmessage" ? `#${meta.channelName}` : "Slack";
  const title = titleFromText(markdown);
  // A one-line capture is all title; a longer one keeps every line in the body.
  const body = markdown.includes("\n") || Array.from(markdown).length > Array.from(title).length ? markdown : "";
  return {
    title: title || "Captured from Slack",
    body,
    project: null,
    sourceUrl: null,
    sourceRef: null,
    author: meta.userName ? `@${meta.userName} (${where})` : where,
  };
}

/** Only Slack's own hosts get a reply posted to them: a forged response_url
 *  can't turn the endpoint into a way to reach anywhere else. */
export function isSlackResponseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "hooks.slack.com" || url.hostname.endsWith(".slack.com"));
  } catch {
    return false;
  }
}
