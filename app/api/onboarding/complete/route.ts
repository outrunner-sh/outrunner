import { NextResponse } from "next/server";

import { activeOrgId } from "@/lib/orgs/server";
import { orgCaller } from "@/lib/orgs/routes";
import { markOrgSetUp } from "@/lib/orgs/setup.deps";

/** The active org's setup is done: its first environment made, or an admin
 *  skipped it. Recorded on the org, so no one is sent through it again
 *  (lib/orgs/setup.ts). Its admins' to say. */
export async function POST(request: Request) {
  const orgId = await activeOrgId().catch(() => undefined);
  if (!orgId) return NextResponse.json({ error: "Make or join an org first." }, { status: 409 });
  const caller = await orgCaller(request, orgId, { admin: true });
  if (caller instanceof Response) return caller;
  try {
    await markOrgSetUp(orgId, caller.owner.id);
  } catch (error) {
    console.error(`Could not mark org ${orgId} set up`, error);
    return NextResponse.json({ error: "Could not save that. Please try again." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
