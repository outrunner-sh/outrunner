import { after, NextResponse } from "next/server";

import { firstSighting } from "@/lib/db/slack-agent";
import { optionalEnv } from "@/lib/env";
import { type AgentMessage, handleAgentMessage } from "@/lib/slack/agent-run";
import { verifySlackSignature } from "@/lib/slack/slack";

/** Slack sends nothing larger; anything that is, isn't Slack. */
const MAX_BODY_BYTES = 256 * 1024;

type SlackEvent = {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: string;
  files?: { name?: string }[];
};

/**
 * The Slack agent's Events API endpoint: mentions of Outrunner, replies in
 * threads it's in, and DMs. Checked against the app's signing secret, each
 * event handled once (Slack sends one again when it isn't answered in 3
 * seconds), answered at once, and the turn run after (lib/slack/agent-run.ts).
 */
export async function POST(request: Request) {
  const secret = optionalEnv("SLACK_SIGNING_SECRET");
  if (!secret) return NextResponse.json({ error: "Slack isn't set up on this deployment." }, { status: 404 });

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
  const verified = verifySlackSignature({
    secret,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    body: raw,
  });
  if (!verified) return new NextResponse(null, { status: 401 });

  let envelope: { type?: string; challenge?: string; event_id?: string; team_id?: string; event?: SlackEvent };
  try {
    envelope = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  // Slack checks the URL once, when the app's events are set up.
  if (envelope.type === "url_verification") return NextResponse.json({ challenge: envelope.challenge });
  if (envelope.type !== "event_callback" || !envelope.event || !envelope.team_id || !envelope.event_id) {
    return new NextResponse(null, { status: 200 });
  }

  const message = agentMessage(envelope.team_id, envelope.event, envelope.event_id);
  if (message && (await firstSighting(envelope.event_id))) {
    after(() => handleAgentMessage(message));
  }
  return new NextResponse(null, { status: 200 });
}

/**
 * What the agent hears: a person's message, mentioning it (app_mention), in
 * a thread or DM, or new in a channel it watches (message). Edits and joins
 * aren't heard. A bot's message is passed on only when it mentions the bot,
 * marked as a bot's: only a Mission on call that takes bots' messages hears
 * it (lib/missions/slack-route.ts). A message that
 * mentions the bot comes as both; the handler leaves the message event of it
 * to the app_mention.
 */
function agentMessage(teamId: string, event: SlackEvent, eventId: string): AgentMessage | null {
  if (!event.channel || !event.ts || typeof event.text !== "string") return null;
  const files = (event.files ?? []).flatMap((f) => (typeof f.name === "string" ? [f.name.slice(0, 200)] : [])).slice(0, 20);
  const extra = { eventId, ...(files.length > 0 && { files }) };
  if (event.bot_id) {
    if (event.type !== "app_mention") return null;
    const user = event.user ?? event.bot_id;
    return { teamId, channel: event.channel, user, text: event.text, ts: event.ts, threadTs: event.thread_ts, mention: true, botId: event.bot_id, ...extra };
  }
  if (!event.user) return null;
  if (event.type === "app_mention") {
    return { teamId, channel: event.channel, user: event.user, text: event.text, ts: event.ts, threadTs: event.thread_ts, mention: true, ...extra };
  }
  if (event.type !== "message" || (event.subtype && event.subtype !== "file_share")) return null;
  // A new message in a channel (not in a thread) is heard only where the
  // channel is watched: the handler checks.
  const topLevel = event.channel_type !== "im" && !event.thread_ts;
  return {
    topLevel,
    teamId,
    channel: event.channel,
    channelType: event.channel_type ?? null,
    user: event.user,
    text: event.text,
    ts: event.ts,
    threadTs: event.thread_ts,
    mention: false,
    ...extra,
  };
}
