import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { listMyOrgs } from "@/lib/db/orgs";
import { isSameOriginRequest } from "@/lib/http/guards";
import { signInFirst } from "@/lib/http/settings-save";
import { setActiveOrg } from "@/lib/orgs/server";

/** Show another org, `{ orgId }`: one the signed-in user is a member of. */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();

  const body = (await request.json().catch(() => null)) as { orgId?: unknown } | null;
  const orgs = await listMyOrgs();
  const org = orgs.find((o) => o.id === body?.orgId);
  if (!org) return NextResponse.json({ error: "You aren't a member of that org." }, { status: 404 });
  await setActiveOrg(org.id);
  return NextResponse.json({ org });
}
