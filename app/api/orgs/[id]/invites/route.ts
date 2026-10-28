import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { createInvite } from "@/lib/db/org-members";
import { getOrg } from "@/lib/db/orgs";
import { emailInvite, inviteLink } from "@/lib/orgs/notify";
import { changingMembers, inviteEmail, orgCaller, postedRole } from "@/lib/orgs/routes";

/**
 * Invite someone to a team org, `{ email, role }`: its admins may. Inviting
 * the same email again replaces the open invite. Answers the link, shown to
 * the admin once (only its hash is kept), and whether it was emailed: without
 * an email sender (lib/email/send.ts) the admin shares it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;

  const body = (await request.json().catch(() => null)) as { email?: unknown; role?: unknown } | null;
  const email = inviteEmail(body?.email);
  if (!email) return NextResponse.json({ error: "Enter the email address to invite." }, { status: 400 });
  const role = postedRole(body?.role ?? "member");
  if (!role) return NextResponse.json({ error: "Invite them as an admin or a member." }, { status: 400 });

  return changingMembers("the org's invites", async () => {
    const org = await getOrg(id);
    if (!org || org.personal) {
      return NextResponse.json({ error: "Only a team org has members to invite." }, { status: 409 });
    }
    const { token, invite } = await createInvite({ orgId: id, email, role, invitedBy: caller.owner.id });
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "member.invited",
      resource: { type: "invite", id: invite.id, label: email },
      details: { role },
    });
    const link = inviteLink(token, new URL(request.url).origin);
    const emailed = await emailInvite({ to: email, orgName: org.name, inviter: caller.owner.name, link });
    return NextResponse.json({ invite, link, emailed }, { status: 201 });
  });
}
