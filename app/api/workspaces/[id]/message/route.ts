import { after, NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { resetCiTurnsOfSession } from "@/lib/db/github-loop";
import { isSameOriginRequest } from "@/lib/http/guards";
import { claimFirstPrompt, markFirstPromptSent, recordWorkspaceMode, releaseFirstPrompt, renewFirstPrompt } from "@/lib/db/repositories";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_PLAN_MODE, SessionMode } from "@/lib/runtime/agent-protocol";
import { requireFeature } from "@/lib/runtime/box-features";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";
import { boxUpgrade } from "@/lib/runtime/session-environment";
import { materializeAttachments } from "@/lib/runtime/materialize-attachments";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { agentChat, chatMissingOnBox, requestedChat } from "@/lib/session/chat-target";
import { attachmentsUnavailable } from "@/lib/runtime/worktree-access";
import { abandonedBefore, firstPromptKey, gateFirstPrompt } from "@/lib/session/first-prompt-claim";
import { nameSessionFromPrompt } from "@/lib/session/name-session";
import { sendFailureMessage } from "@/lib/session/send-failure";
import { BOX_GONE } from "@/lib/session/session-codes";
import { FROM_HEADER } from "@/lib/slack/from";
import { watchSent } from "@/lib/session/watch";

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
 *
 * A prompt names the mode it goes in (`mode`, lib/session/session-mode.ts):
 * the agent puts the session in it first. `dismiss` answers the plan the agent
 * is waiting on approval for, closing its menu first. Plan mode needs an agent
 * that knows it (AGENT_FEATURE_PLAN_MODE): an older one would build instead, so
 * the box is upgraded first, and the send refused where it can't be.
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
    | { content?: string; attachmentIds?: unknown; firstPromptKey?: unknown; mode?: unknown; dismiss?: unknown }
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
  const mode = SessionMode.safeParse(body?.mode);
  if (body?.mode !== undefined && !mode.success) {
    return NextResponse.json({ error: "A prompt's mode is build or plan." }, { status: 400 });
  }
  const dismiss = body?.dismiss === true;

  const { id } = await context.params;
  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Message",
    needsComputer: "Messaging requires a Runtime Computer provider.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, provider, sandboxId, secret, agent, identity } = reach.reached;
  // One of the session's chats (?chat=), or its main one: everything that
  // names none (Slack, a Mission, the API) goes there.
  const named = await requestedChat(request, workspace);
  if (!named.ok) return named.response;
  const chat = agentChat(named.chat);

  const noFiles = attachmentsUnavailable(attachmentIds.length, workspace.worktreePath);
  if (noFiles) return NextResponse.json({ error: noFiles }, { status: 409 });

  // Claimed before anything reaches the box, so a repeat copies no files
  // either; let go on any failure below, so a retry still sends.
  // A session's first prompt is its main chat's.
  const gate = await gateFirstPrompt(
    chat ? null : firstPromptKey(body?.firstPromptKey),
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

  // Building is what every agent does with a prompt, so only plan mode, or
  // answering a plan, needs one that knows modes. A build prompt names its
  // mode all the same: it takes a session that was planning out of it.
  const asked = mode.success ? mode.data : undefined;
  if (asked === "plan" || dismiss) {
    try {
      await requireFeature(
        {
          features: async () => (await agent.health(identity)).features ?? [],
          upgrade: boxUpgrade(provider, sandboxId, secret, owner.id, workspace.id),
        },
        AGENT_FEATURE_PLAN_MODE,
        "plan before it builds",
      );
    } catch (error) {
      await gate.release();
      if (error instanceof OutdatedComputerError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      console.error(`Message: couldn't ready plan mode for ${workspace.id}`, error);
      return NextResponse.json({ error: "Couldn't reach the Runtime Computer. Try again." }, { status: 502 });
    }
  }

  try {
    await agent.sendMessage(identity, prompt, { ...(asked && { mode: asked }), ...(dismiss && { dismiss }) }, chat);
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
    // A switch of mode refused mid-turn, or an engine without plan mode: the
    // agent's own words say what to do.
    if (error instanceof AgentRequestError && (error.error?.code === "CONFLICT" || error.error?.code === "UNSUPPORTED")) {
      return NextResponse.json({ error: error.error.message }, { status: 409 });
    }
    if (chat && chatMissingOnBox(error)) {
      return NextResponse.json(
        { error: "This chat isn't running on the session's computer. Reload the page to start it again." },
        { status: 409 },
      );
    }
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
  // What follows is the session's: its main chat's turn, mode, Slack thread
  // and title. A chat's own turn is followed on its page.
  if (chat) return NextResponse.json({ result: "sent", titled: false });
  // A person's word (typed here, or said in Slack or on GitHub), not CI
  // failing: the CI follow-ups of its pull requests count their turns from
  // none again (lib/github/followups.ts).
  if (request.headers.get(FROM_HEADER) !== "github-ci") {
    after(() =>
      resetCiTurnsOfSession(workspace.id).catch((error: unknown) =>
        console.error(`Message: couldn't reset ${workspace.id}'s CI turns`, error),
      ),
    );
  }
  // Working, for every client at once, and watched until its turn ends
  // (lib/session/watch.ts): where it stands in the sidebar follows.
  after(() => watchSent(workspace.id, workspace.ownerId));
  if (asked && asked !== workspace.mode) await recordWorkspaceMode(workspace.id, asked);
  // A session started from Slack, in step with its thread: what's typed here
  // goes there too, and the reply with it. Not what came from the thread, or
  // from GitHub, which no one typed here.
  if (workspace.slackThreadUrl && workspace.slackSync !== false && content && !request.headers.get(FROM_HEADER)) {
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
