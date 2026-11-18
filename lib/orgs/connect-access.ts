import { NextResponse } from "next/server";

import { orgProjectsLevel } from "@/lib/db/org-access";
import { allows } from "@/lib/orgs/access";

/** The answer to give someone who may not connect repositories to the org:
 *  that needs write on all its projects (20261028145000_org_access.sql), as
 *  the database holds too. Null when they may, or there's no org (before
 *  orgs). */
export async function connectRefusal(userId: string, orgId: string | undefined): Promise<Response | null> {
  if (!orgId || allows(await orgProjectsLevel(userId, orgId), "write")) return null;
  return NextResponse.json(
    {
      error: "Connecting repositories to this org needs write access on all its repositories. Ask one of its admins.",
      code: "needs_write",
    },
    { status: 403 },
  );
}
