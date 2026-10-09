import { redirect } from "next/navigation";

import { AcceptInvite } from "@/components/accept-invite";
import { getOwnerSafe } from "@/lib/auth/owner";
import { previewTeamInvite } from "@/lib/db/teams";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/teams/roles";

export const dynamic = "force-dynamic";

/** Where an invite link lands: what it would join, and a Join button. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!(await getOwnerSafe())) redirect(`/signin?next=${encodeURIComponent(`/invite/${token}`)}`);

  const invite = await previewTeamInvite(token);
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-4 px-6 py-16">
      {invite ? (
        <>
          <h1 className="text-xl font-semibold text-foreground">Join {invite.teamName}</h1>
          <p className="text-sm text-muted-foreground">
            You&apos;re invited as {ROLE_LABEL[invite.role].toLowerCase()}: {ROLE_DESCRIPTION[invite.role].toLowerCase()}.
            You&apos;ll run sessions on your own GitHub and Claude.
          </p>
          <AcceptInvite token={token} teamName={invite.teamName} />
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold text-foreground">This invite can&apos;t be used</h1>
          <p className="text-sm text-muted-foreground">
            It has expired, been used or been revoked. Ask whoever sent it for a new link.
          </p>
        </>
      )}
    </div>
  );
}
