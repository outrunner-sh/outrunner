import { after, NextResponse } from "next/server";

import { setMemberRoles } from "@/lib/db/org-access";
import { closeAdmissionIfAlone, removeMember, setMemberRole } from "@/lib/db/org-members";
import { isUuid } from "@/lib/ids";
import { settleNewRemoval } from "@/lib/orgs/removal.deps";
import { changingMembers, orgCaller, postedRole } from "@/lib/orgs/routes";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { getRuntimeProvider } from "@/lib/runtime/provider";

type Params = { params: Promise<{ id: string; userId: string }> };

/** Make a member an admin or a member, `{ role }`. The org's admins may;
 *  never the last admin a member. */
export async function PATCH(request: Request, { params }: Params) {
  const { id, userId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if (!isUuid(userId)) return NextResponse.json({ error: "No such member." }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { role?: unknown } | null;
  const role = postedRole(body?.role);
  if (!role) return NextResponse.json({ error: "Choose admin or member." }, { status: 400 });

  return changingMembers("a member's role", async () => {
    await setMemberRole(id, userId, role);
    // An admin writes everything: the roles they held as a member would only
    // mislead if they're made a member again.
    if (role === "admin") await setMemberRoles(id, userId, []);
    return NextResponse.json({ member: { userId, role } });
  });
}

/**
 * Take a member out of a team org: its admins may take anyone, and a member
 * may take themselves (leave). Never the last admin. They lose the org at
 * once; their sessions in it are stopped now and deleted in 30 days unless
 * they come back (lib/orgs/removal.ts).
 */
export async function DELETE(request: Request, { params }: Params) {
  const { id, userId } = await params;
  if (!isUuid(userId)) return NextResponse.json({ error: "No such member." }, { status: 404 });
  const caller = await orgCaller(request, id, { admin: false });
  if (caller instanceof Response) return caller;
  const leaving = userId === caller.owner.id;
  if (!leaving && caller.role !== "admin") {
    return NextResponse.json({ error: "Only the org's admins can remove someone." }, { status: 403 });
  }

  return changingMembers("the org's members", async () => {
    await removeMember(id, userId, caller.owner.id);
    after(async () => {
      const provider = getRuntimeProvider();
      if (isComputerProvider(provider)) await settleNewRemoval(provider, id, userId);
      await closeAdmissionIfAlone(userId).catch((error: unknown) =>
        console.error(`Could not close ${userId}'s way in after leaving org ${id}`, error),
      );
    });
    return NextResponse.json({ removed: userId, left: leaving });
  });
}
