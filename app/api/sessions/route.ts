import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { listOrgSessions } from "@/lib/db/session-list";
import { listWorkspaces } from "@/lib/db/repositories";
import { getOrgContext } from "@/lib/orgs/server";

/**
 * The sessions list (app/(app)/workspaces): every session in the active org
 * the user may see (lib/db/session-list.ts), with where each stands. `me` is
 * the user, for the owner filter.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  try {
    const orgId = (await getOrgContext())?.active.id;
    const own = await listWorkspaces({ orgId });
    const sessions = await listOrgSessions({ userId: owner.id, orgId, own });
    return NextResponse.json({ sessions, me: owner.id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Sessions list: couldn't read it", error);
    return NextResponse.json({ error: "Couldn't load the sessions. Please try again." }, { status: 500 });
  }
}
