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

  const message = agentMessage(envelope.team_id, envelope.event);
  if (message && (await firstSighting(envelope.event_id))) {
    after(() => handleAgentMessage(message));
  }
  return new NextResponse(null, { status: 200 });
}

/**
 * What the agent hears: a person's message, mentioning it (app_mention) or in
 * a thread or DM (message). Edits, joins and bots' messages aren't heard. A
 * message that mentions the bot comes as both; the handler leaves the message
 * event of it to the app_mention.
 */
function agentMessage(teamId: string, event: SlackEvent): AgentMessage | null {
  if (event.bot_id || !event.user || !event.channel || !event.ts || typeof event.text !== "string") return null;
  if (event.type === "app_mention") {
    return { teamId, channel: event.channel, user: event.user, text: event.text, ts: event.ts, threadTs: event.thread_ts, mention: true };
  }
  if (event.type !== "message" || event.subtype) return null;
  // In a channel only replies in threads are heard; in a DM, everything.
  if (event.channel_type !== "im" && !event.thread_ts) return null;
  return {
    teamId,
    channel: event.channel,
    channelType: event.channel_type ?? null,
    user: event.user,
    text: event.text,
    ts: event.ts,
    threadTs: event.thread_ts,
    mention: false,
  };
}
