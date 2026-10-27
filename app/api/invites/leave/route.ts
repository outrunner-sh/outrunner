import { NextResponse } from "next/server";

import { getAuthUser } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { endInviteeVisit } from "@/lib/orgs/invitee";

/** An invite's page found it no longer works: someone it signed in, who isn't
 *  let in otherwise, is signed out (lib/orgs/invitee.ts). */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  await endInviteeVisit(await getAuthUser().catch(() => null));
  return new NextResponse(null, { status: 204 });
}
