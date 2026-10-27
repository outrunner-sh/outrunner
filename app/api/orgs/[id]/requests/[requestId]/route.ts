import { NextResponse } from "next/server";

import { approveJoinRequest, declineJoinRequest, setAdmitted } from "@/lib/db/org-members";
import { isUuid } from "@/lib/ids";
import { changingMembers, orgCaller, postedRole } from "@/lib/orgs/routes";

/**
 * Answer a request to join, `{ action: "approve", role }` or
 * `{ action: "decline" }`: the org's admins may. Approved, the asker is a
 * member and may sign in from then on, past the allowlist; declined, they may
 * ask again after a week.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; requestId: string }> }) {
  const { id, requestId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if (!isUuid(requestId)) return NextResponse.json({ error: "No such request." }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { action?: unknown; role?: unknown } | null;
  if (body?.action === "decline") {
    return changingMembers("a request to join", async () => {
      await declineJoinRequest(id, requestId, caller.owner.id);
      return NextResponse.json({ declined: requestId });
    });
  }
  if (body?.action !== "approve") {
    return NextResponse.json({ error: "Approve or decline the request." }, { status: 400 });
  }
  const role = postedRole(body.role ?? "member");
  if (!role) return NextResponse.json({ error: "Approve them as an admin or a member." }, { status: 400 });

  return changingMembers("a request to join", async () => {
    const userId = await approveJoinRequest(id, requestId, caller.owner.id, role);
    await setAdmitted(userId, true);
    return NextResponse.json({ approved: requestId, member: { userId, role } });
  });
}
