import { after, NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { claimFirstPrompt, markFirstPromptSent, releaseFirstPrompt, renewFirstPrompt } from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { materializeAttachments } from "@/lib/runtime/materialize-attachments";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { attachmentsUnavailable } from "@/lib/runtime/worktree-access";
import { abandonedBefore, firstPromptKey, gateFirstPrompt } from "@/lib/session/first-prompt-claim";
import { nameSessionFromPrompt } from "@/lib/session/name-session";
import { sendFailureMessage } from "@/lib/session/send-failure";
import { BOX_GONE } from "@/lib/session/session-codes";
import { FROM_HEADER } from "@/lib/slack/from";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Deliver a user prompt to a workspace's agent session. This is the jcode-engine
 * prompt path: the browser composer POSTs here (same-origin), and we proxy to
 * the runtime-agent's /message over the control preview URL. The reply streams
 * back to the browser on the Conversation SSE, not in this response.
 *
 * Server-to-server on purpose: the agent lives on a different origin (the
 * Daytona preview host) with no CORS, and the Runtime token secret must stay on
 * the server.
 *
 * A session's first prompt names its idempotency key (firstPromptKey): it is
 * sent once per key. A repeat answers as sent without sending again, or, while
 * the first send is still going, asks to be tried again
 * (lib/session/first-prompt-claim.ts).
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { content?: string; attachmentIds?: unknown; firstPromptKey?: unknown }
    | null;
  const content = body?.content?.trim() ?? "";
  const attachmentIds = Array.isArray(body?.attachmentIds)
    ? body.attachmentIds.filter((id): id is string => typeof id === "string")
    : [];
  // A prompt of only attachments is legitimate — "here's a screenshot" — so
  // require text only when nothing else is being sent.
  if (!content && attachmentIds.length === 0) {
    return NextResponse.json({ error: "A non-empty content is required." }, { status: 400 });
  }

  const { id } = await context.params;
  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Message",
    needsComputer: "Messaging requires a Runtime Computer provider.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, provider, sandboxId, agent, identity } = reach.reached;

  const noFiles = attachmentsUnavailable(attachmentIds.length, workspace.worktreePath);
  if (noFiles) return NextResponse.json({ error: noFiles }, { status: 409 });

  // Claimed before anything reaches the box, so a repeat copies no files
  // either; let go on any failure below, so a retry still sends.
  const gate = await gateFirstPrompt(
    firstPromptKey(body?.firstPromptKey),
    {
      claim: (key) => claimFirstPrompt(workspace.id, key, abandonedBefore(new Date())),
      renew: (key, claimedAt) => renewFirstPrompt(workspace.id, key, claimedAt),
      sent: (key, claimedAt) => markFirstPromptSent(workspace.id, key, claimedAt),
      release: (key, claimedAt) => releaseFirstPrompt(workspace.id, key, claimedAt),
    },
    workspace.id,
  );
  if (gate.outcome === "sent") return NextResponse.json({ result: "already", titled: false });
  // Not "sent": that send may yet fail, and this page would think it went.
  const stillGoing = () =>
    NextResponse.json(
      { error: "Your first message is still on its way. Try again in a moment if it doesn't show up." },
      { status: 409 },
    );
  if (gate.outcome === "sending") return stillGoing();

  let prompt = content;
  try {
    prompt = await materializeAttachments({
      provider,
      sandboxId,
      worktreePath: workspace.worktreePath,
      workspaceId: workspace.id,
      attachmentIds,
      prompt: content,
    });
  } catch (error) {
    console.error(`Message: attachments failed for ${workspace.id}`, error);
    await gate.release();
    return NextResponse.json(
      { error: "Could not attach those files. Please try again." },
      { status: 502 },
    );
  }

  // Renewed as it goes, so no repeat can take the claim over while the box
  // has it; one that already did (attaching ran past the claim's time) sends
  // it instead of this request.
  if (!(await gate.held())) return stillGoing();

  try {
    await agent.sendMessage(identity, prompt);
  } catch (error) {
    console.error(`Message: send failed for ${workspace.id}`, error);
    // Released on any failure, an unclear one too (a timeout, a reset after
    // the body went): on purpose, as the page then offers Retry, and a
    // prompt kept from it would be lost if the box never got it. Only that
    // Retry, pressed by the user, can send it twice: as before the key.
    await gate.release();
    // The agent's own 404 (unknown workspace) means the session's box is gone,
    // so retrying fails the same way every time. Tag it (BOX_GONE) so the
    // composer drops Retry and points at a new session instead of offering one.
    // A 404 without the agent's error body (a proxy in front of a box that is
    // restarting, an agent without the route) may pass on retry, so keeps it.
    if (error instanceof AgentRequestError && error.status === 404 && error.error?.message === "unknown workspace") {
      return NextResponse.json(
        { error: "This session isn't running on its computer any more.", code: BOX_GONE },
        { status: 502 },
      );
    }
    return NextResponse.json(
      {
        error:
          error instanceof AgentRequestError
            ? sendFailureMessage(error.error?.message)
            : "Couldn't reach the Runtime Computer. Try again.",
      },
      { status: 502 },
    );
  }
  await gate.sent();
  // A session started from Slack, in step with its thread: what's typed here
  // goes there too, and the reply with it. Not what came from the thread.
  if (workspace.slackThreadUrl && workspace.slackSync !== false && content && request.headers.get(FROM_HEADER) !== "slack") {
    const author = owner.name || owner.githubLogin;
    after(async () => {
      const { echoToThread } = await import("@/lib/slack/relay");
      await echoToThread(workspace.id, author, content).catch((error: unknown) =>
        console.error(`Message: couldn't post to ${workspace.id}'s Slack thread`, error),
      );
    });
  }
  return NextResponse.json({ result: "sent", titled: await nameSessionFromPrompt(workspace, content) });
}
