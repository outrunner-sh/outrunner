import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getSessionComputer, getWorkspace } from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { SessionUrls } from "@/lib/runtime/agent-protocol";
import { DaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import { sessionAccessFor } from "@/lib/runtime/session-guard";

export const dynamic = "force-dynamic";

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
 * refresh the URLs — do NOT cache them past a single connection.
 *
 * See docs/architecture/session-contract.md.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in as the Runtime owner." }, { status: 401 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return providerErrorResponse(resolution);
  const provider = resolution.provider;

  // Session attach is Daytona-only — the local/modal providers have no
  // runtime-agent to speak the frozen PTY protocol.
  if (!(provider instanceof DaytonaRuntimeProvider)) {
    return NextResponse.json(
      { error: "Live sessions require the Daytona runtime provider." },
      { status: 409 },
    );
  }

  // The session's own computer: a teammate watching attaches to its creator's.
  const session = await getSessionComputer(workspace);
  if (!session?.computer.daytonaSandboxId) {
    return NextResponse.json(
      { error: "This project has no Runtime Computer. Create a workspace first." },
      { status: 409 },
    );
  }
  const { computer, secret } = session;
  const sandboxId = session.computer.daytonaSandboxId;
  if (computer.status !== "ready") {
    return NextResponse.json(
      { error: `Runtime Computer is ${computer.status}; try again shortly.` },
      { status: 409 },
    );
  }

  let target;
  try {
    target = await provider.agentTarget(sandboxId, secret);
  } catch (error) {
    console.error(`Session attach: agentTarget failed for ${workspace.id}`, error);
    return NextResponse.json(
      { error: "Could not reach the Runtime Computer. Try again." },
      { status: 503 },
    );
  }

  const identity: WorkspaceIdentity = {
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    computerId: computer.id,
    userId: owner.id,
  };
  const agent = new AgentClient(target);

  // Fetch the current WorkspaceSummary alongside the URLs so the browser has
  // it on the first paint without an extra round-trip. If the agent hiccups,
  // omit summary — clients can hit /api/workspaces/[id]/summary directly.
  let summary;
  try {
    summary = await agent.workspaceSummary(identity);
  } catch (error) {
    console.warn(`Session attach: summary fetch failed for ${workspace.id}`, error);
  }

  // Its creator gets the terminal and the conversation; a teammate, the
  // conversation alone, on a token the agent refuses for anything else.
  const body: SessionUrls =
    (await sessionAccessFor(workspace, owner.id)) === "act"
      ? { ptyUrl: agent.ptyUrl(identity), eventsUrl: agent.eventsUrl(identity), ...(summary && { summary }) }
      : { eventsUrl: agent.eventsUrl({ ...identity, readOnly: true }), ...(summary && { summary }) };
  return NextResponse.json(SessionUrls.parse(body));
}
