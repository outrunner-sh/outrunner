import { NextResponse } from "next/server";

import { getOwner, type Owner } from "@/lib/auth/owner";
import { sessionPlan } from "@/lib/billing/entitlements";
import { cloudBoxStartGate, CloudLimitError, isPlanLimitError, UPGRADE_HREF } from "@/lib/billing/limits";
import { getSandboxSettings } from "@/lib/db/credentials";
import { orgDefaultsFor } from "@/lib/db/org-defaults";
import {
  getProject,
  getWorkspaceComputer,
  getWorkspace,
  markRuntimeComputerStoppedIfReady,
  readRuntimeComputerSecret,
} from "@/lib/db/repositories";
import { optionalGitToken, sessionGitAs } from "@/lib/github/identity.deps";
import { isSameOriginRequest } from "@/lib/http/guards";
import { newBoxSize } from "@/lib/orgs/defaults";
import { AgentClient, AgentRequestError, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { SessionUrls } from "@/lib/runtime/agent-protocol";
import { isComputerProvider, type ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { scopeOf } from "@/lib/runtime/computer-scope";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import { ensureComputer } from "@/lib/runtime/runtime-computer-service";
import { boxSizeOn, computerMadeBy, endedBoxOf, sandboxOf } from "@/lib/runtime/sandbox-choice";
import { readyRelaunch } from "@/lib/runtime/relaunch.deps";
import { signInFailure } from "@/lib/runtime/session-auth";
import { boxUpgrade, runtimeSessionEnvironment } from "@/lib/runtime/session-environment";
import type { RuntimeComputer, Workspace } from "@/lib/runtime/types";
import { BOX_GONE, BOX_RESTORE_FAILED } from "@/lib/session/session-codes";

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
      if (error instanceof CloudLimitError) return NextResponse.json(error.denial, { status: 403 });
      const refused = isPlanLimitError(error);
      if (refused) return NextResponse.json({ error: refused.message, settingsHref: UPGRADE_HREF }, { status: 403 });
      console.error(`Session attach: could not bring back the box for ${workspace.id}`, error);
      return NextResponse.json(
        { error: "Couldn't restart this session's box. Try again.", code: BOX_RESTORE_FAILED },
        { status: 503 },
      );
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
  const agent = new AgentClient(target);

  // A hover must leave the session as it found it: a warm-up signs nothing in
  // and starts nothing. Its URLs stand in for the page's first attach, so it
  // answers only for a session already running — the one case where that
  // attach would have had nothing to start anyway. The conversation itself is
  // read from the transcript on disk, running or not, so the warm-up still
  // fills the page's cache.
  let summary;
  if (warm) {
    summary = await agent.workspaceSummary(identity).catch((error: unknown) => {
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
      await readyRelaunch(agent, identity, upgrade, workspace, owner.id);
      await agent.startWorkspace(identity);
    } catch (error) {
      const failure = signInFailure(error);
      if (failure) return NextResponse.json(failure, { status: 409 });
      if (error instanceof AgentRequestError && error.status === 404) {
        return NextResponse.json(
          {
            error:
              "This session's box ended and couldn't be restored, so its uncommitted files are gone. Start a new session.",
            code: BOX_GONE,
          },
          { status: 410 },
        );
      }
      console.warn(`Session attach: start failed for ${workspace.id}`, error);
    }
  }

  // Fetch the current WorkspaceSummary alongside the URLs so the browser has
  // it on the first paint without an extra round-trip. If the agent hiccups,
  // omit summary — clients can hit /api/workspaces/[id]/summary directly. A
  // warm-up already has it, from the check above.
  if (!summary) {
    try {
      summary = await agent.workspaceSummary(identity);
    } catch (error) {
      console.warn(`Session attach: summary fetch failed for ${workspace.id}`, error);
    }
  }

  const body: SessionUrls = {
    ptyUrl: agent.ptyUrl(identity),
    eventsUrl: agent.eventsUrl(identity),
    ...(summary && { summary }),
  };
  return NextResponse.json(SessionUrls.parse(body));
}

/**
 * The session's computer (its own box, or its project's shared one) once its
 * box is up again, when that box ended or another request is bringing it
 * back; null when there's nothing to do (it is up, or it is another
 * provider's). The claim lets one request restore it; the others wait for it.
 */
async function bringBack(
  provider: ComputerRuntimeProvider,
  workspace: Workspace,
  computer: RuntimeComputer,
  owner: Owner,
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
  // A box is about to start: the plan's hours and box count get their say,
  // and the claim in the database enforces the cap.
  const scope = scopeOf(workspace, computer);
  const gate = await cloudBoxStartGate(owner, project.orgId, provider.name, scope);
  if ("denial" in gate) throw new CloudLimitError(gate.denial);
  const ensured = await ensureComputer(provider, {
    scope,
    repoFullName: project.fullName,
    // A review box's mirror as the App, as on create: never its user's token.
    githubToken: await optionalGitToken(owner.id, project, await sessionGitAs(workspace.id)),
    sessionEnv: await runtimeSessionEnvironment(owner.id, workspace.id),
    // The owner's size now, as a new box on this provider would get, within
    // their plan on Outrunner's: Modal sizes a box as it starts, restored or not.
    size: boxSizeOn(
      sandboxOf(provider.name),
      newBoxSize(await getSandboxSettings(owner.id), (await orgDefaultsFor(project.orgId)).boxSize),
      await sessionPlan(owner.id, project.orgId),
    ),
    previousSandboxId: ended,
    maxLiveComputers: gate.cap,
  });
  return ensured.computer;
}
