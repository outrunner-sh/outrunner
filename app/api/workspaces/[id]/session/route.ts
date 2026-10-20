import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { planFor } from "@/lib/billing/entitlements";
import { agentAuthStore, getSandboxSettings } from "@/lib/db/credentials";
import {
  getProject,
  getRuntimeComputerByProject,
  getWorkspace,
  markRuntimeComputerStoppedIfReady,
  readRuntimeComputerSecret,
} from "@/lib/db/repositories";
import { optionalGithubToken } from "@/lib/github/token";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentClient, AgentRequestError, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { SessionUrls } from "@/lib/runtime/agent-protocol";
import { isComputerProvider, type ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import { ensureProjectRuntimeComputer } from "@/lib/runtime/runtime-computer-service";
import { boxSizeOn, computerMadeBy, endedBoxOf, sandboxOf } from "@/lib/runtime/sandbox-choice";
import { sessionAuthClient, signInFailure, signInSession } from "@/lib/runtime/session-auth";
import { boxUpgrade, runtimeSessionEnvironment } from "@/lib/runtime/session-environment";
import type { RuntimeComputer } from "@/lib/runtime/types";

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
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
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
  if (!isComputerProvider(provider)) {
    return NextResponse.json(
      { error: "Live sessions require a Runtime Computer provider." },
      { status: 409 },
    );
  }

  let computer = await getRuntimeComputerByProject(workspace.projectId);
  // A box that ended on its own (Modal, after a day) comes back on the disk it
  // left, so the session opens where it was.
  if (computer && provider.restoresBoxes) {
    try {
      computer = (await bringBack(provider, computer, owner.id)) ?? computer;
    } catch (error) {
      console.error(`Session attach: could not bring back the box for ${workspace.id}`, error);
      return NextResponse.json(
        { error: "Could not restart this session's sandbox. Try again." },
        { status: 503 },
      );
    }
  }
  if (!computer || !computer.daytonaSandboxId) {
    return NextResponse.json(
      { error: "This project has no Runtime Computer. Create a workspace first." },
      { status: 409 },
    );
  }
  if (computer.status !== "ready") {
    return NextResponse.json(
      { error: `Runtime Computer is ${computer.status}; try again shortly.` },
      { status: 409 },
    );
  }

  const secret = await readRuntimeComputerSecret(computer.id);
  if (!secret) {
    return NextResponse.json({ error: "Runtime Computer secret missing." }, { status: 500 });
  }

  let target;
  try {
    target = await provider.agentTarget(computer.daytonaSandboxId, secret);
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

  // On a box that comes back after it ends, the session's Claude may not be
  // running: start it (continuing its conversation), or leave it be if it is.
  if (provider.restoresBoxes) {
    try {
      // Signed in as the user picks now, before it launches.
      const upgrade = boxUpgrade(provider, computer.daytonaSandboxId, secret, owner.id);
      await signInSession(sessionAuthClient(agent, identity, upgrade), workspace.agent, agentAuthStore(owner.id));
      await agent.startWorkspace(identity);
    } catch (error) {
      const failure = signInFailure(error);
      if (failure) return NextResponse.json(failure, { status: 409 });
      if (error instanceof AgentRequestError && error.status === 404) {
        return NextResponse.json(
          {
            error:
              "This session's sandbox ended and couldn't be restored, so its files are gone. Start a new session.",
          },
          { status: 410 },
        );
      }
      console.warn(`Session attach: start failed for ${workspace.id}`, error);
    }
  }

  // Fetch the current WorkspaceSummary alongside the URLs so the browser has
  // it on the first paint without an extra round-trip. If the agent hiccups,
  // omit summary — clients can hit /api/workspaces/[id]/summary directly.
  let summary;
  try {
    summary = await agent.workspaceSummary(identity);
  } catch (error) {
    console.warn(`Session attach: summary fetch failed for ${workspace.id}`, error);
  }

  const body: SessionUrls = {
    ptyUrl: agent.ptyUrl(identity),
    eventsUrl: agent.eventsUrl(identity),
    ...(summary && { summary }),
  };
  return NextResponse.json(SessionUrls.parse(body));
}

/**
 * The project's computer once its box is up again, when that box ended or
 * another request is bringing it back; null when there's nothing to do (it is
 * up, or it is another provider's). The claim lets one request restore it;
 * the others wait for it.
 */
async function bringBack(
  provider: ComputerRuntimeProvider,
  computer: RuntimeComputer,
  userId: string,
): Promise<RuntimeComputer | null> {
  if (computerMadeBy(computer) !== provider.name) return null;
  let ended = endedBoxOf(computer, provider.name);
  if (computer.status === "ready" && computer.daytonaSandboxId) {
    if (await provider.computerAlive(computer.daytonaSandboxId)) return null;
    await markRuntimeComputerStoppedIfReady(computer.id, computer.daytonaSandboxId);
    ended = computer.daytonaSandboxId;
  } else if (!ended && computer.status !== "provisioning") {
    return null;
  }
  const project = await getProject(computer.projectId);
  if (!project) throw new Error(`Project ${computer.projectId} not found`);
  const ensured = await ensureProjectRuntimeComputer(provider, {
    projectId: project.id,
    repoFullName: project.fullName,
    githubToken: await optionalGithubToken(userId),
    sessionEnv: await runtimeSessionEnvironment(userId),
    // The owner's size now, as a new box on this provider would get, within
    // their plan on Outrunner's: Modal sizes a box as it starts, restored or not.
    size: boxSizeOn(sandboxOf(provider.name), (await getSandboxSettings(userId)).boxSize, await planFor(userId)),
    previousSandboxId: ended,
  });
  return ensured.computer;
}
