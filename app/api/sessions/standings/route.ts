import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { listWorkspacePullRequests, listWorkspaces } from "@/lib/db/repositories";
import { readStandings } from "@/lib/db/session-standing";
import { getOrgContext } from "@/lib/orgs/server";
import { sessionPullRequests } from "@/lib/session/session-view";

/**
 * Where each of the user's sessions in the active org stands
 * (lib/session/standing.ts), for the sidebar to keep its groups live
 * (hooks/use-standings.ts) without re-reading everything the layout does.
 * `ids` is every session listed, so a page can tell one was made or deleted
 * elsewhere and refresh.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const orgs = await getOrgContext();
  const workspaces = await listWorkspaces({ orgId: orgs?.active.id });
  const pullRequests = sessionPullRequests(workspaces, await listWorkspacePullRequests(workspaces.map((w) => w.id)));
  const standings = await readStandings(owner.id, workspaces, pullRequests);
  return NextResponse.json(
    { standings, ids: workspaces.map((w) => w.id) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
