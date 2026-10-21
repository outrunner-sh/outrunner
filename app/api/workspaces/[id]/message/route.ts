import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { materializeAttachments } from "@/lib/runtime/materialize-attachments";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { nameSessionFromPrompt } from "@/lib/session/name-session";
import { sendFailureMessage } from "@/lib/session/send-failure";

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
    | { content?: string; attachmentIds?: unknown }
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

  let prompt = content;
  try {
    prompt = await materializeAttachments({
      provider,
      sandboxId,
      worktreePath: workspace.worktreePath ?? "",
      workspaceId: workspace.id,
      attachmentIds,
      prompt: content,
    });
  } catch (error) {
    console.error(`Message: attachments failed for ${workspace.id}`, error);
    return NextResponse.json(
      { error: "Could not attach those files. Please try again." },
      { status: 502 },
    );
  }

  try {
    await agent.sendMessage(identity, prompt);
  } catch (error) {
    console.error(`Message: send failed for ${workspace.id}`, error);
    // The agent's 404 (unknown workspace) means the session's box is gone, so
    // retrying won't help; say so rather than offering a retry.
    return NextResponse.json(
      {
        error:
          error instanceof AgentRequestError
            ? error.status === 404
              ? "This session isn't running on its computer any more."
              : sendFailureMessage(error.error?.message)
            : "Couldn't reach the Runtime Computer. Try again.",
      },
      { status: 502 },
    );
  }
  return NextResponse.json({ result: "sent", titled: await nameSessionFromPrompt(workspace, content) });
}
