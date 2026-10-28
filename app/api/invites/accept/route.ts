import { NextResponse } from "next/server";

import { personLabel } from "@/lib/audit/labels";
import { recordAudit } from "@/lib/audit/record";
import { getAuthUser } from "@/lib/auth/owner";
import { acceptInvite, inviteByToken, MemberChangeError, setAdmitted } from "@/lib/db/org-members";
import { githubErrorResponse } from "@/lib/github/http";
import { optionalGithubToken } from "@/lib/github/token";
import { isSameOriginRequest } from "@/lib/http/guards";
import { signInFirst } from "@/lib/http/settings-save";
import { endInviteeVisit } from "@/lib/orgs/invitee";
import { setActiveOrg } from "@/lib/orgs/server";
import { verifiedEmailsFor } from "@/lib/orgs/verified-emails";

/**
 * Accept an invite, `{ token }`, as the signed-in user: when the email it was
 * sent to is one GitHub or Google has verified for them. They join the org, which the
 * app then shows, and may sign in from then on past the allowlist.
 *
 * Anyone signed in (with GitHub or Google) may ask, not only those the allowlist names: this
 * is how someone it doesn't name comes in, and only with an invite to them.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const user = await getAuthUser();
  if (!user) return signInFirst();
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token : "";
  if (!token.startsWith("or_inv_")) return NextResponse.json({ error: "That isn't an invite link." }, { status: 400 });

  try {
    const invite = await inviteByToken(token);
    // Each dead end signs out someone this invite alone signed in
    // (lib/orgs/invitee.ts): to try another account, they sign in again.
    if (!invite || !invite.open) {
      await endInviteeVisit(user);
      return NextResponse.json({ error: new MemberChangeError("invite_invalid").message }, { status: 410 });
    }
    const emails = await verifiedEmailsFor(user, await optionalGithubToken(user.id));
    if (!emails.some((e) => e.email.toLowerCase() === invite.email)) {
      await endInviteeVisit(user);
      return NextResponse.json(
        {
          error: `This invite is for ${invite.email}. Sign in with the GitHub or Google account that has that email verified.`,
          code: "invite_email_mismatch",
        },
        { status: 403 },
      );
    }
    const orgId = await acceptInvite(token, user.id);
    await recordAudit({
      orgId,
      actor: { id: user.id, githubLogin: "", name: await personLabel(user.id), email: user.email ?? null },
      action: "member.joined",
      resource: { type: "member", id: user.id, label: invite.email },
      details: { role: invite.role },
    });
    // The invite is accepted either way. Failing these only delays: they're
    // admitted at their next sign-in, as a team org's member, and can pick
    // the org in the switcher.
    await setAdmitted(user.id, true).catch((error: unknown) => console.error(`Could not admit ${user.id}`, error));
    await setActiveOrg(orgId).catch((error: unknown) => console.error(`Could not show org ${orgId}`, error));
    return NextResponse.json({ org: { id: orgId, name: invite.orgName } });
  } catch (error) {
    if (error instanceof MemberChangeError) {
      await endInviteeVisit(user);
      return NextResponse.json({ error: error.message }, { status: 410 });
    }
    return githubErrorResponse(error, "Couldn't accept the invite. Try again.");
  }
}
