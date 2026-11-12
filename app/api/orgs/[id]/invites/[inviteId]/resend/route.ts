import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { rotateInvite } from "@/lib/db/org-members";
import { getOrg } from "@/lib/db/orgs";
import { canSendEmail } from "@/lib/email/send";
import { resendInvite, resendLimiter } from "@/lib/orgs/invite-resend";
import { newInviteToken } from "@/lib/orgs/invite-token";
import { emailInvite, inviteLink } from "@/lib/orgs/notify";
import { changingMembers, orgCaller } from "@/lib/orgs/routes";

/** Kept for the process's life: the control plane is one instance. */
const limit = resendLimiter();

/**
 * Send an open invite again, with a new link: the old one stops working and
 * the invite works INVITE_DAYS more (lib/orgs/invite-resend.ts). The org's
 * admins may. Answers the link and whether it was emailed, as inviting does.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; inviteId: string }> }) {
  const { id, inviteId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const origin = new URL(request.url).origin;

  return changingMembers("the org's invites", async () => {
    const answer = await resendInvite(
      { orgId: id, inviteId, caller },
      {
        now: () => new Date(),
        newToken: newInviteToken,
        org: getOrg,
        rotate: rotateInvite,
        link: (token) => inviteLink(token, origin),
        canSendEmail,
        email: emailInvite,
        audit: recordAudit,
        limit,
      },
    );
    return NextResponse.json(answer.body, { status: answer.status, headers: answer.headers });
  });
}
