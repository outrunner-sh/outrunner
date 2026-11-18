/**
 * The few Slack Web API calls the Slack agent makes, with the bot token of
 * the Slack workspace it's in (slack_installations). Each throws a
 * SlackApiError carrying Slack's error code when Slack says `ok: false`.
 */

const API = "https://slack.com/api";
const TIMEOUT_MS = 10_000;

export class SlackApiError extends Error {
  readonly method: string;
  readonly code: string;
  /** Slack's Retry-After, in seconds, on a rate limit. */
  readonly retryAfter: number | null;

  constructor(method: string, code: string, retryAfter: number | null = null) {
    super(`Slack ${method}: ${code}`);
    this.name = "SlackApiError";
    this.method = method;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** A call whose outcome Slack never said: it timed out, or the connection
 *  failed once the request may have gone. A write may have happened. */
export class SlackUnknownOutcomeError extends Error {
  readonly method: string;

  constructor(method: string, cause: unknown) {
    super(`Slack ${method}: no answer (${cause instanceof Error ? cause.message : String(cause)})`, { cause });
    this.name = "SlackUnknownOutcomeError";
    this.method = method;
  }
}

type SlackBlock = Record<string, unknown>;

/** Writes go as JSON; reads (conversations.replies, users.info) only take a
 *  form body. */
async function call<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  encoding: "json" | "form" = "json",
): Promise<T> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) if (value !== undefined) form.set(key, String(value));
  let response: Response;
  try {
    response = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": encoding === "json" ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded",
      },
      body: encoding === "json" ? JSON.stringify(body) : form.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new SlackUnknownOutcomeError(method, error);
  }
  const retry = Number(response.headers.get("retry-after"));
  const retryAfter = Number.isFinite(retry) && retry > 0 ? retry : null;
  if (response.status === 429) throw new SlackApiError(method, "ratelimited", retryAfter ?? 30);
  // A 5xx says nothing of whether a write happened.
  if (response.status >= 500) throw new SlackUnknownOutcomeError(method, new Error(`http_${response.status}`));
  const answer = (await response.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (!answer?.ok) throw new SlackApiError(method, answer?.error ?? `http_${response.status}`, retryAfter);
  return answer;
}

/** Post in a thread (or start one, without `threadTs`); the message's ts. */
export async function postMessage(
  token: string,
  message: { channel: string; threadTs?: string; text: string; blocks?: SlackBlock[]; marker?: string },
): Promise<string> {
  const answer = await call<{ ts: string }>(token, "chat.postMessage", {
    channel: message.channel,
    thread_ts: message.threadTs,
    text: message.text,
    blocks: message.blocks,
    unfurl_links: false,
    unfurl_media: false,
    // A marker in the message's metadata, unseen in Slack: how a post whose
    // outcome is unknown is found in its thread (lib/missions/slack-outbox.ts).
    ...(message.marker && { metadata: { event_type: MARKER_EVENT, event_payload: { op: message.marker } } }),
  });
  return answer.ts;
}

/** The metadata event type an Outrunner post's marker goes under. */
export const MARKER_EVENT = "outrunner_post";

/** The markers of the bot's posts in a thread, and whether every reply was
 *  read (false: the thread is longer than `maxPages` pages). */
export async function threadMarkers(
  token: string,
  channel: string,
  threadTs: string,
  maxPages = 5,
): Promise<{ markers: Map<string, string>; complete: boolean }> {
  const markers = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const answer = await call<{
      messages?: { ts: string; metadata?: { event_type?: string; event_payload?: { op?: unknown } } }[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    }>(token, "conversations.replies", { channel, ts: threadTs, limit: 200, include_all_metadata: true, ...(cursor && { cursor }) }, "form");
    for (const m of answer.messages ?? []) {
      const op = m.metadata?.event_type === MARKER_EVENT ? m.metadata.event_payload?.op : undefined;
      if (typeof op === "string") markers.set(op, m.ts);
    }
    cursor = answer.response_metadata?.next_cursor || undefined;
    if (!answer.has_more || !cursor) return { markers, complete: true };
  }
  return { markers, complete: false };
}

/** Change a message the bot posted (the spec card, once it's filed). */
export async function updateMessage(
  token: string,
  message: { channel: string; ts: string; text: string; blocks?: SlackBlock[] },
): Promise<void> {
  await call(token, "chat.update", { channel: message.channel, ts: message.ts, text: message.text, blocks: message.blocks });
}

/** A message only `user` sees, in the thread. */
export async function postEphemeral(
  token: string,
  message: { channel: string; user: string; threadTs?: string; text: string },
): Promise<void> {
  await call(token, "chat.postEphemeral", {
    channel: message.channel,
    user: message.user,
    thread_ts: message.threadTs,
    text: message.text,
  });
}

export type ThreadMessage = {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
};

/** A thread's messages, oldest first (its first page: up to `limit`). */
export async function threadReplies(token: string, channel: string, threadTs: string, limit = 100): Promise<ThreadMessage[]> {
  const answer = await call<{ messages?: ThreadMessage[] }>(token, "conversations.replies", {
    channel,
    ts: threadTs,
    limit,
  }, "form");
  return answer.messages ?? [];
}

/** People's names as Slack shows them, by user id. One the API won't answer
 *  for keeps its id. */
export async function userNames(token: string, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(
    [...new Set(ids)].slice(0, 20).map(async (id) => {
      try {
        const answer = await call<{ user?: { name?: string; real_name?: string; profile?: { display_name?: string } } }>(
          token,
          "users.info",
          { user: id },
          "form",
        );
        const u = answer.user;
        names.set(id, u?.profile?.display_name || u?.real_name || u?.name || id);
      } catch {
        names.set(id, id);
      }
    }),
  );
  return names;
}

/** Take down a message the bot posted (an offer someone answered). */
export async function deleteMessage(token: string, message: { channel: string; ts: string }): Promise<void> {
  await call(token, "chat.delete", { channel: message.channel, ts: message.ts });
}

/** Mark a message with an emoji (👀 working, ✅ done…); one already there is
 *  fine. Needs reactions:write. */
export async function addReaction(token: string, message: { channel: string; ts: string; name: string }): Promise<void> {
  try {
    await call(token, "reactions.add", { channel: message.channel, timestamp: message.ts, name: message.name });
  } catch (error) {
    if (!(error instanceof SlackApiError && error.code === "already_reacted")) throw error;
  }
}

export async function removeReaction(token: string, message: { channel: string; ts: string; name: string }): Promise<void> {
  try {
    await call(token, "reactions.remove", { channel: message.channel, timestamp: message.ts, name: message.name });
  } catch (error) {
    if (!(error instanceof SlackApiError && error.code === "no_reaction")) throw error;
  }
}

/** Rechecked on delegated reads: Slack Connect/shared channels are not eligible. */
export async function channelIdentity(token: string, channel: string) {
  const answer = await call<{ channel: {
    id: string; is_im?: boolean; is_mpim?: boolean; is_member?: boolean; is_private?: boolean;
    is_ext_shared?: boolean; is_org_shared?: boolean; is_shared?: boolean;
    shared_team_ids?: string[];
  } }>(token, "conversations.info", { channel }, "form");
  return answer.channel;
}

export async function senderIdentity(token: string, user: string) {
  const answer = await call<{ user: { id: string; team_id?: string; deleted?: boolean; is_bot?: boolean; is_stranger?: boolean } }>(
    token, "users.info", { user }, "form",
  );
  return answer.user;
}

/** A message's link, as Slack makes it (chat.getPermalink: no scope needed
 *  beyond the bot being in the channel). */
export async function messagePermalink(token: string, channel: string, ts: string): Promise<string | null> {
  const answer = await call<{ permalink?: string }>(token, "chat.getPermalink", { channel, message_ts: ts }, "form");
  return typeof answer.permalink === "string" && answer.permalink.startsWith("https://") ? answer.permalink : null;
}

/** The channels the bot is in, public and private (channels:read,
 *  groups:read): what a Mission can be put on call in from the app. */
export async function botChannels(token: string, max = 400): Promise<{ id: string; name: string; shared: boolean; private: boolean }[]> {
  const found: { id: string; name: string; shared: boolean; private: boolean }[] = [];
  let cursor: string | undefined;
  do {
    const answer = await call<{
      channels?: { id: string; name?: string; is_member?: boolean; is_private?: boolean; is_ext_shared?: boolean; is_org_shared?: boolean; is_shared?: boolean }[];
      response_metadata?: { next_cursor?: string };
    }>(
      token,
      "conversations.list",
      { types: "public_channel,private_channel", exclude_archived: true, limit: 200, ...(cursor && { cursor }) },
      "form",
    );
    for (const c of answer.channels ?? []) {
      if (c.is_member) found.push({ id: c.id, name: c.name ?? c.id, shared: !!(c.is_ext_shared || c.is_org_shared || c.is_shared), private: !!c.is_private });
    }
    cursor = answer.response_metadata?.next_cursor || undefined;
  } while (cursor && found.length < max);
  return found;
}

/** The private channels a person is in that the bot can see
 *  (users.conversations, channels:read and groups:read): whom a private
 *  channel's name and messages may be shown to. */
export async function userPrivateChannels(token: string, user: string, max = 1000): Promise<Set<string>> {
  const found = new Set<string>();
  let cursor: string | undefined;
  do {
    const answer = await call<{ channels?: { id: string }[]; response_metadata?: { next_cursor?: string } }>(
      token,
      "users.conversations",
      { user, types: "private_channel", exclude_archived: true, limit: 200, ...(cursor && { cursor }) },
      "form",
    );
    for (const c of answer.channels ?? []) found.add(c.id);
    cursor = answer.response_metadata?.next_cursor || undefined;
  } while (cursor && found.size < max);
  return found;
}

/** A channel's name, or null when Slack won't say. */
export async function channelName(token: string, channel: string): Promise<string | null> {
  const answer = await call<{ channel?: { name?: string } }>(token, "conversations.info", { channel }, "form").catch(() => null);
  return answer?.channel?.name ?? null;
}

/** The markers of the bot's posts in a channel since `oldest` (a ts), for a
 *  root post whose send went unanswered; whether every message was read. */
export async function channelMarkers(
  token: string,
  channel: string,
  oldest: string,
  maxPages = 3,
): Promise<{ markers: Map<string, string>; complete: boolean }> {
  const markers = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const answer = await call<{
      messages?: { ts: string; metadata?: { event_type?: string; event_payload?: { op?: unknown } } }[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    }>(token, "conversations.history", { channel, oldest, limit: 200, include_all_metadata: true, ...(cursor && { cursor }) }, "form");
    for (const m of answer.messages ?? []) {
      const op = m.metadata?.event_type === MARKER_EVENT ? m.metadata.event_payload?.op : undefined;
      if (typeof op === "string") markers.set(op, m.ts);
    }
    cursor = answer.response_metadata?.next_cursor || undefined;
    if (!answer.has_more || !cursor) return { markers, complete: true };
  }
  return { markers, complete: false };
}

/** Who the bot is in a Slack workspace: its user and bot ids (auth.test). */
export async function botIdentity(token: string): Promise<{ userId: string | null; botId: string | null }> {
  const answer = await call<{ user_id?: string; bot_id?: string }>(token, "auth.test", {}, "form");
  return { userId: answer.user_id ?? null, botId: answer.bot_id ?? null };
}
