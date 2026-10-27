import { confirmSlackLink } from "@/app/slack/link/actions";
import { ConfirmButton } from "@/app/slack/link/confirm-button";
import { getOwnerSafe } from "@/lib/auth/owner";
import { optionalEnv } from "@/lib/env";
import { verifyLinkToken } from "@/lib/slack/slack";

/**
 * Where the Slack app's "Connect Slack to Outrunner" reply sends a user who
 * isn't linked yet. The proxy has already sent a signed-out visitor through
 * sign-in and back here, so this only asks the signed-in user to confirm the
 * Slack user the link names is them.
 */
export default async function SlackLinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { t } = await searchParams;
  const token = typeof t === "string" ? t : "";
  const identity = verifyLinkToken(token, optionalEnv("SLACK_SIGNING_SECRET") ?? "");
  const owner = await getOwnerSafe();

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-8">
        <p aria-hidden className="select-none font-display text-7xl leading-none text-foreground/25">
          outrunner
        </p>
        {!identity ? (
          <div className="space-y-2">
            <h1 className="text-sm">This link has expired or isn&apos;t complete.</h1>
            <p className="text-xs text-muted-foreground">
              Run <code className="font-mono">/triage</code> in Slack again for a new one.
            </p>
          </div>
        ) : !owner ? (
          <div className="space-y-2">
            <h1 className="text-sm">Sign in to Outrunner first.</h1>
            <p className="text-xs text-muted-foreground">Then open the link from Slack again.</p>
          </div>
        ) : (
          <form action={confirmSlackLink} className="space-y-6">
            <div className="space-y-2">
              <h1 className="text-sm">Connect Slack to Outrunner?</h1>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Slack user</dt>
                <dd className="font-mono">{identity.userName ? `@${identity.userName}` : identity.userId}</dd>
                <dt className="text-muted-foreground">Workspace</dt>
                <dd className="font-mono">{identity.teamName ?? identity.teamId}</dd>
                <dt className="text-muted-foreground">Outrunner</dt>
                <dd className="font-mono">{owner.githubLogin}</dd>
              </dl>
              <p className="text-xs text-muted-foreground">
                What this Slack user sends to triage will land in your triage. Only confirm if you just asked for
                this link in Slack yourself.
              </p>
            </div>
            <input type="hidden" name="t" value={token} />
            <ConfirmButton />
          </form>
        )}
      </div>
    </main>
  );
}
