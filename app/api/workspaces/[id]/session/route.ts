import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getWorkspaceComputer, getWorkspace, readRuntimeComputerSecret } from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_CHATS, SessionUrls } from "@/lib/runtime/agent-protocol";
import { withRuntimeAgentRecovery } from "@/lib/runtime/agent-recovery";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import { readyChatRelaunch, readyRelaunch } from "@/lib/runtime/relaunch.deps";
import { OutdatedComputerError, signInFailure } from "@/lib/runtime/session-auth";
import { boxUpgrade } from "@/lib/runtime/session-environment";
import type { Workspace } from "@/lib/runtime/types";
import { bringBack } from "@/lib/session/bring-back-box";
import { bringBackFailure } from "@/lib/session/box-failure";
import { agentChat, chatMissingOnBox, requestedChat } from "@/lib/session/chat-target";
import { relaunchFailure } from "@/lib/session/relaunch-failure";
import { requireFeature } from "@/lib/runtime/box-features";
import type { SessionChat } from "@/lib/session/chats";

// May ensure/boot a Runtime Computer before minting session tokens; give it the
// same 60s cap as provisioning (serverless hosts only; a no-op on Railway).
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Session attach endpoint. Mints the short-lived Runtime tokens (5-min TTL) and
 * returns the URLs the browser subscribes to for this Workspace Session.
 *
 * The token secret never leaves the server; only the finished `wss://` URL
 * crosses the wire. Clients re-call this route whenever a stream closes to
 * refresh the URLs — do NOT cache them past a single connection. Such a re-call
 * adds `?fresh=1`: the box's endpoint, kept a few minutes server-side, is looked
 * up again in case it is what failed.
 *
 * `?warm=1` is the sidebar warming a session up as the pointer rests on it
 * (lib/session/warm-session.ts): the same answer, but read-only. It never
 * brings back a box that ended (minutes, and a box that runs) on a hover, and
 * never signs the session in or starts it; it says 409 instead, which the
 * warm-up treats as nothing to warm.
 *
 * See docs/architecture/session-contract.md.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const { id } = await context.params;
  // Read alongside the owner check: the read is the owner's own anyway (RLS),
  // and signed out it is dropped unread, failed or not.
  const [ownerRead, workspaceRead] = await Promise.allSettled([getOwner(), getWorkspace(id)]);
  if (ownerRead.status === "rejected") throw ownerRead.reason;
  const owner = ownerRead.value;
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  if (workspaceRead.status === "rejected") throw workspaceRead.reason;
  const workspace = workspaceRead.value;
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  // The chat the page shows (?chat=): its main one unless it names another.
  const named = await requestedChat(request, workspace);
  if (!named.ok) return named.response;
  const chat = agentChat(named.chat);

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return providerErrorResponse(resolution);
  const provider = resolution.provider;

  // Session attach is Daytona-only — the local/modal providers have no
  // runtime-agent to speak the frozen PTY protocol.
  if (!isComputerProvider(provider)) {
    return NextResponse.json(
      { error: "Live sessions require a Runtime Computer provider." },
      { status: 409 },
    );
  }

  const query = new URL(request.url).searchParams;
  const warm = query.get("warm") === "1";
  let computer = await getWorkspaceComputer(workspace);
  if (warm && computer && provider.restoresBoxes) {
    const up =
      computer.status === "ready" &&
      computer.daytonaSandboxId !== null &&
      (await provider.computerAlive(computer.daytonaSandboxId));
    if (!up) return NextResponse.json({ error: "Its sandbox isn't up to warm." }, { status: 409 });
  } else if (computer && provider.restoresBoxes) {
    // A box that ended on its own (Modal, after a day) comes back on the disk
    // it left, so the session opens where it was.
    try {
      computer = (await bringBack(provider, workspace, computer, owner)) ?? computer;
    } catch (error) {
      const failure = bringBackFailure(error);
      if (failure.status !== 403) console.error(`Session attach: could not bring back the box for ${workspace.id}`, error);
      return NextResponse.json(failure.body, { status: failure.status });
    }
  }
  if (!computer || !computer.daytonaSandboxId) {
    return NextResponse.json(
      { error: "This session has no Runtime Computer. Start a new session." },
      { status: 409 },
    );
  }
  if (computer.status !== "ready") {
    return NextResponse.json(
      { error: `Its box is ${computer.status}, so it can't be shown yet.` },
      { status: 409 },
    );
  }

  const secret = await readRuntimeComputerSecret(computer.id);
  if (!secret) {
    return NextResponse.json({ error: "Runtime Computer secret missing." }, { status: 500 });
  }

  let target;
  try {
    target = await provider.agentTarget(computer.daytonaSandboxId, secret, { fresh: query.get("fresh") === "1" });
  } catch (error) {
    console.error(`Session attach: agentTarget failed for ${workspace.id}`, error);
    return NextResponse.json(
      { error: "Outrunner couldn't reach its box." },
      { status: 503 },
    );
  }

  const identity: WorkspaceIdentity = {
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    computerId: computer.id,
    userId: owner.id,
  };
  let agent = new AgentClient(target);

  // A hover must leave the session as it found it: a warm-up signs nothing in
  // and starts nothing. Its URLs stand in for the page's first attach, so it
  // answers only for a session already running — the one case where that
  // attach would have had nothing to start anyway. The conversation itself is
  // read from the transcript on disk, running or not, so the warm-up still
  // fills the page's cache.
  let summary;
  if (warm) {
    summary = await agent.workspaceSummary(identity, chat).catch((error: unknown) => {
      console.warn(`Session warm: summary fetch failed for ${workspace.id}`, error);
      return undefined;
    });
    if (summary?.state !== "running") {
      return NextResponse.json({ error: "Its session isn't running to warm." }, { status: 409 });
    }
  }

  // On a box that comes back after it ends, the session's Claude may not be
  // running: start it (continuing its conversation), or leave it be if it is.
  if (!warm && provider.restoresBoxes) {
    try {
      // Signed in as the user picks now, and on its model's key as it is
      // now, before it launches.
      const upgrade = boxUpgrade(provider, computer.daytonaSandboxId, secret, owner.id, workspace.id);
      const recovered = await withRuntimeAgentRecovery(
        {
          provider,
          sandboxId: computer.daytonaSandboxId,
          secret,
          agent,
          identity,
          upgrade,
          workspaceId: workspace.id,
        },
        async (current) => {
          await readyRelaunch(current, identity, upgrade, workspace, owner.id);
          await current.startWorkspace(identity);
        },
        (current) => {
          // If recovery itself fails, the best-effort summary probe below
          // should still use the most recently discovered endpoint.
          agent = current;
        },
      );
      agent = recovered.agent;
    } catch (error) {
      const failed = await relaunchFailure(error, async () => {
        try {
          summary = await agent.workspaceSummary(identity);
        } catch (summaryError) {
          console.warn(`Session attach: couldn't ask whether ${workspace.id} is running`, summaryError);
          return false;
        }
        return summary.state === "running";
      });
      if (failed) {
        if (failed.status === 502) console.error(`Session attach: ${workspace.id}'s agent didn't start`, error);
        return NextResponse.json(failed.body, { status: failed.status });
      }
      console.warn(`Session attach: start failed for ${workspace.id}, running anyway`, error);
    }
  }

  // A chat other than the main one runs beside it: started (continuing its
  // conversation) when it isn't running, which a box that paused or came
  // back stopped, and made again on a box that lost it (a restore onto a new
  // one), its conversation there starting afresh.
  if (!warm && chat) {
    const failed = await startChat(agent, identity, named.chat, workspace, owner.id, provider.restoresBoxes
      ? boxUpgrade(provider, computer.daytonaSandboxId, secret, owner.id, workspace.id)
      : undefined, provider.restoresBoxes);
    if (failed) return failed;
  }

  // Fetch the current WorkspaceSummary alongside the URLs so the browser has
  // it on the first paint without an extra round-trip. If the agent hiccups,
  // omit summary — clients can hit /api/workspaces/[id]/summary directly. A
  // warm-up already has it, from the check above.
  if (!summary) {
    try {
      summary = await agent.workspaceSummary(identity, chat);
    } catch (error) {
      console.warn(`Session attach: summary fetch failed for ${workspace.id}`, error);
    }
  }

  const body: SessionUrls = {
    ptyUrl: agent.ptyUrl(identity, chat),
    eventsUrl: agent.eventsUrl(identity, chat),
    ...(summary && { summary }),
  };
  return NextResponse.json(SessionUrls.parse(body));
}

/**
 * Start one of a session's chats other than its main one, readied first
 * (readyChatRelaunch) where the box may have come back without its sign-in
 * (`ready`), or made again where the box doesn't have it. Null once it runs;
 * else the response saying why it can't.
 */
async function startChat(
  agent: AgentClient,
  identity: WorkspaceIdentity,
  chat: SessionChat,
  workspace: Workspace,
  ownerId: string,
  upgrade: (() => Promise<void>) | undefined,
  ready: boolean,
): Promise<NextResponse | null> {
  try {
    if (ready) await readyChatRelaunch(agent, identity, upgrade, workspace, chat, ownerId);
    try {
      await agent.startWorkspace(identity, chat.id);
    } catch (error) {
      if (!chatMissingOnBox(error)) throw error;
      await requireFeature(
        { features: async () => (await agent.health(identity)).features ?? [], upgrade },
        AGENT_FEATURE_CHATS,
        "run several chats in a session",
      );
      await agent.createChat(identity, { chatId: chat.id, agent: chat.agent, noStart: true });
      await readyChatRelaunch(agent, identity, upgrade, workspace, chat, ownerId);
      await agent.startWorkspace(identity, chat.id);
    }
    return null;
  } catch (error) {
    const failure = signInFailure(error);
    if (failure) return NextResponse.json(failure, { status: 409 });
    if (error instanceof OutdatedComputerError) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error(`Session attach: chat ${chat.id} of ${workspace.id} didn't start`, error);
    return NextResponse.json({ error: "Couldn't start this chat. Try again." }, { status: 502 });
  }
}
