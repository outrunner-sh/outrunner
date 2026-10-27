import { after, NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/allowlist";
import { slackLinkOwner } from "@/lib/db/slack-links";
import { captureWorkItem, resolveProject } from "@/lib/db/work-items";
import { optionalEnv } from "@/lib/env";
import {
  captureFromCommand,
  captureFromMessage,
  isSlackResponseUrl,
  type MessageAction,
  parseTriageCommand,
  type SlackCapture,
  type SlackIdentity,
  signLinkToken,
  verifySlackSignature,
} from "@/lib/slack/slack";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
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
 * Slack waits three seconds for an answer: a command is answered with its
 * reply directly, a shortcut (whose answer Slack ignores) at once and its
 * reply posted to the payload's response_url after.
 */
export async function POST(request: Request) {
  const secret = optionalEnv("SLACK_SIGNING_SECRET");
  if (!secret) return NextResponse.json({ error: "Slack isn't set up on this deployment." }, { status: 404 });

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
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

/** `/triage [owner/repo] <text>`. */
async function command(form: URLSearchParams, secret: string): Promise<NextResponse> {
  const teamId = form.get("team_id");
  const userId = form.get("user_id");
  if (!teamId || !userId) return new NextResponse(null, { status: 400 });
  const parsed = parseTriageCommand(form.get("text") ?? "");
  if (!parsed) {
    return NextResponse.json(
      ephemeral("Add a work item to your Outrunner triage: `/triage [owner/repo] what needs doing`"),
    );
  }
  const capture = captureFromCommand(parsed.text, {
    channelName: form.get("channel_name"),
    userName: form.get("user_name"),
  });
  const identity: SlackIdentity = {
    teamId,
    teamName: form.get("team_domain"),
    userId,
    userName: form.get("user_name"),
  };
  // A first word that isn't one of the user's workspaces was part of the text.
  const reply = await captureReply(identity, { ...capture, project: parsed.project }, secret, parsed.text);
  return NextResponse.json(reply);
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
  commandText?: string,
): Promise<Reply> {
  try {
    const ownerId = await linkedOwner(identity);
    if (!ownerId) {
      const base = optionalEnv("RUNTIME_BASE_URL");
      if (!base) return ephemeral("Outrunner's address isn't configured, so your account can't be connected yet.");
      const link = new URL(`/slack/link?t=${signLinkToken(identity, secret)}`, base).toString();
      return ephemeral(
        `Connect Slack to your Outrunner account first: <${link}|Connect Slack to Outrunner> (link valid for 10 minutes). Then try again.`,
      );
    }
    const db = createSupabaseAdminClient();
    let projectId: string | null = null;
    let { title, body } = capture;
    if (capture.project) {
      projectId = await resolveProject(db, ownerId, capture.project);
      // Not a workspace of theirs: it was part of what they wrote.
      if (!projectId && commandText !== undefined) {
        const whole = captureFromCommand(`${capture.project} ${commandText}`, { channelName: null, userName: null });
        title = whole.title;
        body = whole.body;
      }
    }
    const result = await captureWorkItem(db, ownerId, {
      title,
      body,
      projectId,
      source: "slack",
      sourceUrl: capture.sourceUrl,
      sourceRef: capture.sourceRef,
      author: capture.author,
    });
    const link = `<${itemUrl(result.item)}|${itemKey(result.item)} ${escapeSlack(result.item.title)}>`;
    return ephemeral(
      result.kind === "created" ? `Added ${link} to triage.` : `Added a note to ${link} (same thread).`,
    );
  } catch (error) {
    console.error("Slack: couldn't capture to triage", error);
    return ephemeral("Couldn't add that to Outrunner triage. Please try again.");
  }
}

/** The Outrunner owner a Slack user is linked to, while they may still sign in. */
async function linkedOwner(identity: SlackIdentity): Promise<string | null> {
  const ownerId = await slackLinkOwner(identity.teamId, identity.userId);
  if (!ownerId) return null;
  const { data, error } = await createSupabaseAdminClient().auth.admin.getUserById(ownerId);
  if (error || !data.user || !isOwner(data.user)) return null;
  return ownerId;
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
