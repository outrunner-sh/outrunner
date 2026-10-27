import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { acceptInvite, inviteByToken, MemberChangeError, setAdmitted } from "@/lib/db/org-members";
import { listVerifiedEmails } from "@/lib/github/client";
import { githubErrorResponse } from "@/lib/github/http";
import { requireGithubToken } from "@/lib/github/token";
import { isSameOriginRequest } from "@/lib/http/guards";
import { signInFirst } from "@/lib/http/settings-save";
import { setActiveOrg } from "@/lib/orgs/server";

/**
 * Accept an invite, `{ token }`, as the signed-in user: when the email it was
 * sent to is one GitHub has verified for them. They join the org, which the
 * app then shows, and may sign in from then on past the allowlist.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token : "";
  if (!token.startsWith("or_inv_")) return NextResponse.json({ error: "That isn't an invite link." }, { status: 400 });

  try {
    const invite = await inviteByToken(token);
    if (!invite || !invite.open) {
      return NextResponse.json({ error: new MemberChangeError("invite_invalid").message }, { status: 410 });
    }
    const emails = await listVerifiedEmails(await requireGithubToken(owner.id));
    if (!emails.some((e) => e.email.toLowerCase() === invite.email)) {
      return NextResponse.json(
        {
          error: `This invite is for ${invite.email}. Add and verify that email on your GitHub account, or sign in with the account that has it.`,
          code: "invite_email_mismatch",
        },
        { status: 403 },
      );
    }
    const orgId = await acceptInvite(token, owner.id);
    await setAdmitted(owner.id, true);
    await setActiveOrg(orgId);
    return NextResponse.json({ org: { id: orgId, name: invite.orgName } });
  } catch (error) {
    if (error instanceof MemberChangeError) return NextResponse.json({ error: error.message }, { status: 410 });
    return githubErrorResponse(error, "Couldn't accept the invite. Try again.");
  }
}
