import { NextResponse } from "next/server";

import { revokeInvite } from "@/lib/db/org-members";
import { isUuid } from "@/lib/ids";
import { changingMembers, orgCaller } from "@/lib/orgs/routes";

/** Withdraw an open invite: its link stops working. The org's admins may. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; inviteId: string }> }) {
  const { id, inviteId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if (!isUuid(inviteId)) return NextResponse.json({ error: "No such invite." }, { status: 404 });

  return changingMembers("the org's invites", async () =>
    (await revokeInvite(id, inviteId))
      ? NextResponse.json({ revoked: inviteId })
      : NextResponse.json({ error: "That invite was used or withdrawn already." }, { status: 404 }),
  );
}
