/**
 * The few Slack Web API calls the Slack agent makes, with the bot token of
 * the Slack workspace it's in (slack_installations). Each throws a
 * SlackApiError carrying Slack's error code when Slack says `ok: false`.
 */

const API = "https://slack.com/api";
const TIMEOUT_MS = 10_000;

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method}: ${code}`);
    this.name = "SlackApiError";
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
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": encoding === "json" ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded",
    },
    body: encoding === "json" ? JSON.stringify(body) : form.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const answer = (await response.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (!answer?.ok) throw new SlackApiError(method, answer?.error ?? `http_${response.status}`);
  return answer;
}

/** Post in a thread (or start one, without `threadTs`); the message's ts. */
export async function postMessage(
  token: string,
  message: { channel: string; threadTs?: string; text: string; blocks?: SlackBlock[] },
): Promise<string> {
  const answer = await call<{ ts: string }>(token, "chat.postMessage", {
    channel: message.channel,
    thread_ts: message.threadTs,
    text: message.text,
    blocks: message.blocks,
    unfurl_links: false,
    unfurl_media: false,
  });
  return answer.ts;
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
    id: string; is_im?: boolean; is_mpim?: boolean; is_member?: boolean;
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
export async function botChannels(token: string, max = 400): Promise<{ id: string; name: string; shared: boolean }[]> {
  const found: { id: string; name: string; shared: boolean }[] = [];
  let cursor: string | undefined;
  do {
    const answer = await call<{
      channels?: { id: string; name?: string; is_member?: boolean; is_ext_shared?: boolean; is_org_shared?: boolean; is_shared?: boolean }[];
      response_metadata?: { next_cursor?: string };
    }>(
      token,
      "conversations.list",
      { types: "public_channel,private_channel", exclude_archived: true, limit: 200, ...(cursor && { cursor }) },
      "form",
    );
    for (const c of answer.channels ?? []) {
      if (c.is_member) found.push({ id: c.id, name: c.name ?? c.id, shared: !!(c.is_ext_shared || c.is_org_shared || c.is_shared) });
    }
    cursor = answer.response_metadata?.next_cursor || undefined;
  } while (cursor && found.length < max);
  return found;
}

/** A channel's name, or null when Slack won't say. */
export async function channelName(token: string, channel: string): Promise<string | null> {
  const answer = await call<{ channel?: { name?: string } }>(token, "conversations.info", { channel }, "form").catch(() => null);
  return answer?.channel?.name ?? null;
}
