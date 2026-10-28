import { after, NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/allowlist";
import { slackLinkTarget } from "@/lib/db/slack-links";
import { captureWorkItem, triageActor, WorkItemChangeError } from "@/lib/db/work-items";
import { optionalEnv } from "@/lib/env";
import { isUuid } from "@/lib/ids";
import { type CardAction, handleCardAction, handleProactiveAction, type ProactiveAction } from "@/lib/slack/agent-run";
import { PROACTIVE_ACTIONS } from "@/lib/slack/proactive-text";
import {
  captureFromCommand,
  captureFromMessage,
  isSlackResponseUrl,
  type MessageAction,
  type SlackCapture,
  type SlackIdentity,
  signLinkToken,
  verifySlackSignature,
} from "@/lib/slack/slack";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { TriageActor } from "@/lib/triage/access";
import { itemUrl } from "@/lib/triage/urls";
import { itemKey } from "@/lib/triage/work-items";

/** The message shortcut's callback ID, as docs/slack-app.md registers it. */
const CAPTURE_CALLBACK = "triage_capture";
/** Slack sends nothing larger; anything that is, isn't Slack. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * The Slack app's one endpoint: the "Send to Outrunner triage" message
 * shortcut and the `/triage` command both post here. Every request is checked
 * against the app's signing secret first. The Slack user must have linked
 * their Outrunner account (the reply to their first try is the link); then
 * the capture lands in their triage and the reply, shown to them alone, links
 * to it.
 *
 * Slack waits three seconds for an answer, and a slow one reads as failed
 * though the item was made (a retry would make it twice). So both are
 * answered at once, and the reply is posted to the request's response_url
 * once the capture is stored.
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

  const form = new URLSearchParams(raw);
  const payload = form.get("payload");
  if (payload) return shortcut(payload, secret);
  if (form.get("command")) return command(form, secret);
  return new NextResponse(null, { status: 400 });
}

/** "Send to Outrunner triage" on a message. */
function shortcut(payload: string, secret: string): NextResponse {
  let action: MessageAction & { type?: string; callback_id?: string; team?: { domain?: string } };
  try {
    action = JSON.parse(payload);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (action.type === "block_actions") return cardAction(payload);
  if (action.type !== "message_action" || action.callback_id !== CAPTURE_CALLBACK) {
    return new NextResponse(null, { status: 200 });
  }
  if (!action.team?.id || !action.user?.id || !action.channel?.id || !action.message?.ts) {
    return new NextResponse(null, { status: 400 });
  }
  const responseUrl = action.response_url;
  const identity: SlackIdentity = {
    teamId: action.team.id,
    teamName: action.team.domain ?? null,
    userId: action.user.id,
    userName: action.user.username ?? action.user.name ?? null,
  };
  after(async () => {
    const reply = await captureReply(identity, captureFromMessage(action), secret);
    if (isSlackResponseUrl(responseUrl)) await postReply(responseUrl, reply);
  });
  return new NextResponse(null, { status: 200 });
}

/** A button on the Slack agent's spec card: answered at once, done after
 *  (lib/slack/agent-run.ts), which reports in the thread. */
function cardAction(payload: string): NextResponse {
  const action = JSON.parse(payload) as {
    team?: { id?: string; domain?: string };
    user?: { id?: string; username?: string; name?: string };
    actions?: { action_id?: string; value?: string; block_id?: string; selected_option?: { value?: string } }[];
    channel?: { id?: string };
    container?: { message_ts?: string };
    message?: { ts?: string; blocks?: Record<string, unknown>[] };
  };
  const clicked = action.actions?.[0];
  // A dropdown sends what was picked, and its block names the conversation.
  if (clicked && !clicked.value && clicked.selected_option?.value && clicked.block_id?.startsWith("spec:")) {
    clicked.value = clicked.block_id.slice("spec:".length);
  }
  if (!action.team?.id || !action.user?.id || !clicked?.action_id || !clicked.value) {
    return new NextResponse(null, { status: 200 });
  }
  // Buttons the agent posted on its own: the watch offer, the verdict.
  if ((Object.values(PROACTIVE_ACTIONS) as string[]).includes(clicked.action_id)) {
    const proactive: ProactiveAction = {
      actionId: clicked.action_id,
      value: clicked.value,
      teamId: action.team.id,
      user: action.user.id,
      userName: action.user.username ?? action.user.name ?? null,
      channel: action.channel?.id ?? null,
      messageTs: action.container?.message_ts ?? action.message?.ts ?? null,
      messageBlocks: action.message?.blocks ?? null,
    };
    after(() => handleProactiveAction(proactive));
    return new NextResponse(null, { status: 200 });
  }
  const card: CardAction = {
    actionId: clicked.action_id,
    conversationId: clicked.value,
    teamId: action.team.id,
    teamDomain: action.team.domain ?? null,
    user: action.user.id,
    userName: action.user.username ?? action.user.name ?? null,
    selected: clicked.selected_option?.value ?? null,
  };
  if (isUuid(card.conversationId)) after(() => handleCardAction(card));
  return new NextResponse(null, { status: 200 });
}

/** `/triage <text>`: the text goes to triage as it is. */
function command(form: URLSearchParams, secret: string): NextResponse {
  const teamId = form.get("team_id");
  const userId = form.get("user_id");
  const responseUrl = form.get("response_url");
  if (!teamId || !userId || !isSlackResponseUrl(responseUrl)) return new NextResponse(null, { status: 400 });
  const text = (form.get("text") ?? "").trim();
  if (!text) {
    return NextResponse.json(ephemeral("Add a note to your Outrunner triage: `/triage what needs doing`"));
  }
  const capture = captureFromCommand(text, {
    channelName: form.get("channel_name"),
    userName: form.get("user_name"),
  });
  const identity: SlackIdentity = {
    teamId,
    teamName: form.get("team_domain"),
    userId,
    userName: form.get("user_name"),
  };
  after(async () => {
    const reply = await captureReply(identity, capture, secret);
    await postReply(responseUrl, reply);
  });
  return NextResponse.json(ephemeral("Adding to Outrunner triage…"));
}

type Reply = { response_type: "ephemeral"; text: string; replace_original?: boolean };

function ephemeral(text: string): Reply {
  return { response_type: "ephemeral", text };
}

/**
 * Store the capture for the Slack user's Outrunner account, and the reply to
 * show them: the item, or the link to connect their account first.
 */
async function captureReply(
  identity: SlackIdentity,
  capture: SlackCapture,
  secret: string,
): Promise<Reply> {
  try {
    const actor = await linkedActor(identity);
    if (!actor) {
      const base = optionalEnv("RUNTIME_BASE_URL");
      if (!base) return ephemeral("Outrunner's address isn't configured, so your account can't be connected yet.");
      const link = new URL(`/slack/link?t=${signLinkToken(identity, secret)}`, base).toString();
      return ephemeral(
        `Connect Slack to your Outrunner account first: <${link}|Connect Slack to Outrunner> (link valid for 10 minutes; you'll sign in with Slack). Then try again.`,
      );
    }
    // Unsorted: the workspace is picked when it's triaged.
    const result = await captureWorkItem(actor, {
      title: capture.title,
      body: capture.body,
      projectId: null,
      source: "slack",
      sourceUrl: capture.sourceUrl,
      sourceRef: capture.sourceRef,
      author: capture.author,
    });
    const link = `<${itemUrl(result.item)}|${itemKey(result.item)} ${escapeSlack(result.item.title)}>`;
    return ephemeral(
      result.kind === "created"
        ? `Added ${link} to triage.`
        : result.reopened
          ? `Added a note to ${link} (same thread) and moved it back to triage.`
          : `Added a note to ${link} (same thread).`,
    );
  } catch (error) {
    if (error instanceof WorkItemChangeError) return ephemeral(error.message);
    console.error("Slack: couldn't capture to triage", error);
    return ephemeral("Couldn't add that to Outrunner triage. Please try again.");
  }
}

/** The Slack user's linked account as a triager in the org their captures
 *  go to, while they may still sign in and are still in that org. */
async function linkedActor(identity: SlackIdentity): Promise<TriageActor | null> {
  const target = await slackLinkTarget(identity.teamId, identity.userId);
  if (!target) return null;
  const { data, error } = await createSupabaseAdminClient().auth.admin.getUserById(target.ownerId);
  if (error || !data.user || !isOwner(data.user)) return null;
  return triageActor(target.ownerId, target.orgId);
}

/** What Slack would read as markup in a link's label. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "¦");
}

async function postReply(responseUrl: string, reply: Reply): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...reply, replace_original: false }),
  }).catch((error: unknown) => console.error("Slack: couldn't post the reply", error));
}
