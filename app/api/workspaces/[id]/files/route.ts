import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import type { FilesResponse } from "@/lib/runtime/agent-protocol";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { changedOnly } from "@/lib/session/file-mentions";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A cloud session's files, for the composer's @ mentions: its changed ones
 * first, newest first, then the rest of its repository, read by git on the
 * box (the agent's GET /workspaces/{id}/files). An agent from before it lists
 * the changed files alone, from its change set: what is most often mentioned,
 * without upgrading the box for a keystroke.
 */
export async function GET(_request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const { id } = await context.params;
  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Files",
    needsComputer: "Mentioning files needs a Runtime Computer provider.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, agent, identity } = reach.reached;

  try {
    return NextResponse.json(await agent.listFiles(identity));
  } catch (error) {
    if (!(error instanceof AgentRequestError && error.status === 404 && !error.error)) {
      console.warn(`Files: couldn't list ${workspace.id}'s files`, error);
      return NextResponse.json({ error: "Couldn't list this session's files." }, { status: 502 });
    }
  }
  try {
    const body: FilesResponse = changedOnly(await agent.listChanges(identity));
    return NextResponse.json(body);
  } catch (error) {
    console.warn(`Files: couldn't list ${workspace.id}'s changed files either`, error);
    return NextResponse.json({ error: "Couldn't list this session's files." }, { status: 502 });
  }
}
