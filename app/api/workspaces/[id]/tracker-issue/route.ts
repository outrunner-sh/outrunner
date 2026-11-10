import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getWorkspace } from "@/lib/db/repositories";
import { trackerIssueOfSession } from "@/lib/db/work-items";

type RouteContext = { params: Promise<{ id: string }> };

/** The Linear or Jira issue a session works on, if any: what Create PR's instructions name
 *  (lib/session/pr-instructions.ts). Whoever can see the session. */
export async function GET(_request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  return NextResponse.json({ issue: await trackerIssueOfSession(workspace.id) });
}
