import { redirect } from "next/navigation";

import { AcceptInvite } from "@/components/accept-invite";
import { EndInviteVisit } from "@/components/end-invite-visit";
import { getAuthUser, isOwner } from "@/lib/auth/owner";
import { inviteByToken } from "@/lib/db/org-members";

/**
 * An invite's link: who invited you to which org, and Accept. Signed out, the
 * proxy sends you to sign in first and back here. Anyone signed in may see
 * it, the allowlist or not: someone it doesn't name, with an open invite to
 * one of their verified emails, is signed in for this page alone, and is let
 * in once they accept (lib/orgs/admission.ts).
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getAuthUser().catch(() => null);
  if (!user) redirect(`/signin?next=${encodeURIComponent(`/invite/${token}`)}`);

  const invite = token.startsWith("or_inv_") ? await inviteByToken(token).catch(() => null) : null;

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-8">
        <p aria-hidden className="select-none font-display text-5xl leading-none text-foreground/25">
          outrunner
        </p>
        {invite?.open ? (
          <div className="space-y-6">
            <div className="space-y-2">
              <h1 className="text-base font-medium text-foreground">Join {invite.orgName}</h1>
              <p className="text-sm text-muted-foreground">
                {`${
                  invite.invitedBy
                    ? `${invite.invitedBy.name} invited ${invite.email}`
                    : `This invite is for ${invite.email},`
                } to join as ${invite.role === "admin" ? "an admin" : "a member"}. You'll see its projects; your sessions stay your own.`}
              </p>
            </div>
            <AcceptInvite token={token} orgName={invite.orgName} />
          </div>
        ) : (
          <div className="space-y-2">
            {/* Signed in by this invite alone: nothing more to do here. */}
            {isOwner(user) ? null : <EndInviteVisit />}
            <h1 className="text-base font-medium text-foreground">This invite doesn&apos;t work any more</h1>
            <p className="text-sm text-muted-foreground">
              It has been used, withdrawn, or has expired (invites last 7 days). Ask an admin of the org for a new one.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
