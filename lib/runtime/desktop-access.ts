import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { hasDesktop } from "@/lib/runtime/types";
import { reachWorkspaceComputer, type WorkspaceComputer } from "@/lib/runtime/workspace-agent";

/**
 * The box whose desktop a request from the Desktop tab may reach, or the
 * response saying why not. The box, not its agent: the desktop is Daytona's
 * own, so it is reached even when the agent is wedged. Who may reach it, and
 * whether the provider has one, are checked as soon as the session is read,
 * before its box is.
 */
export async function reachDesktop(
  request: Request,
  workspaceId: string,
): Promise<{ ok: true; reached: WorkspaceComputer } | { ok: false; response: NextResponse }> {
  if (!isSameOriginRequest(request)) {
    return { ok: false, response: NextResponse.json({ error: "Invalid request origin." }, { status: 403 }) };
  }
  const owner = await getOwner();
  if (!owner) {
    return { ok: false, response: NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 }) };
  }
  return reachWorkspaceComputer(workspaceId, {
    needsComputer: "The desktop runs on Outrunner's cloud computers.",
    admit: (workspace) => {
      // The session's own owner alone, whoever else can read the session:
      // the desktop has a terminal on it, and the browser its sign-ins.
      if (workspace.ownerId !== owner.id) {
        return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
      }
      if (!hasDesktop(workspace.provider)) {
        return NextResponse.json({ error: "The desktop runs on Outrunner's Daytona sandboxes only." }, { status: 409 });
      }
      return null;
    },
  });
}
