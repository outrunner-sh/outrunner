import { NextResponse } from "next/server";

import { isConnector } from "@/lib/automations/connector";
import { setMemberRoles } from "@/lib/db/org-access";
import { isUuid } from "@/lib/ids";
import { changingAccess } from "@/lib/orgs/access-routes";
import { orgCaller } from "@/lib/orgs/routes";

/** Give a member exactly these roles, `{ roleIds }`. The org's admins may;
 *  an admin holds none (they write everything already). */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string; userId: string }> }) {
  const { id, userId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if (!isUuid(userId)) return NextResponse.json({ error: "No such member." }, { status: 404 });
  // The org's outrunner-connector isn't one of its people to change.
  if (await isConnector(userId)) return NextResponse.json({ error: "No such member." }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { roleIds?: unknown } | null;
  const roleIds = body?.roleIds;
  if (!Array.isArray(roleIds) || roleIds.length > 50 || !roleIds.every((r) => typeof r === "string" && isUuid(r))) {
    return NextResponse.json({ error: "Choose the member's roles." }, { status: 400 });
  }
  return changingAccess("a member's roles", async () => {
    await setMemberRoles(id, userId, roleIds as string[]);
    return NextResponse.json({ member: { userId, roleIds } });
  });
}
