import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { hasDesktop } from "@/lib/runtime/types";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * How long a desktop link works: long enough for the browser to open its
 * socket, which stays open after the link lapses. Short because the desktop
 * has a terminal on it: a link that leaks (a shared screen, a history) should
 * be worthless by the time anyone reads it. Reconnecting asks for a new one.
 */
const DESKTOP_LINK_TTL_SECONDS = 120;

/**
 * The desktop on a cloud session's box, for its owner's browser to view and,
 * if they choose, use: started here when it isn't running, so a box runs its
 * display only once someone opens the Desktop tab or the agent reaches for a
 * desktop tool. The answer is `{ url }`, the WebSocket of the desktop's noVNC
 * proxy with its credential in it, which reaches the desktop's VNC server and
 * nothing else on the box (lib/runtime/sandbox/daytona.ts).
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
  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Desktop",
    needsComputer: "The desktop runs on Outrunner's cloud computers.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, provider, sandboxId } = reach.reached;
  // The session's own owner alone, whoever else can read the session: the
  // link is a key to the box's desktop.
  if (workspace.ownerId !== owner.id) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }
  // Before the box is asked: where there is no desktop, nothing is started.
  if (!hasDesktop(workspace.provider)) {
    return NextResponse.json({ error: "The desktop runs on Outrunner's Daytona sandboxes only." }, { status: 409 });
  }

  try {
    const url = await provider.openDesktop(sandboxId, DESKTOP_LINK_TTL_SECONDS);
    if (!url) {
      return NextResponse.json({ error: "This session's sandbox has no desktop." }, { status: 409 });
    }
    return NextResponse.json({ url });
  } catch (error) {
    console.error(`Desktop: failed for ${workspace.id}`, error);
    return NextResponse.json({ error: "Couldn't start the desktop. Please try again." }, { status: 502 });
  }
}
