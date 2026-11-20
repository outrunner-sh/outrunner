import { startSlackLink } from "@/app/slack/link/actions";
import { ContinueButton } from "@/app/slack/link/continue-button";
import { SELECT_OPTIONS } from "@/components/ui/select-options";
import { getOwnerSafe } from "@/lib/auth/owner";
import { optionalEnv } from "@/lib/env";
import { getOrgContext } from "@/lib/orgs/server";
import { verifyLinkToken } from "@/lib/slack/slack";
import { slackSignInConfig } from "@/lib/slack/sign-in";
import { cn } from "@/lib/utils";

/**
 * Where the Slack app's "Connect Slack to Outrunner" reply sends a user who
 * isn't linked yet. The proxy has already sent a signed-out visitor through
 * sign-in and back here. The user picks the org their captures go to, then
 * signs in with Slack as the Slack user the link names, which finishes it.
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
  const orgs = owner ? await getOrgContext().catch(() => null) : null;
  const ready = slackSignInConfig() !== null;

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
        ) : !ready ? (
          <div className="space-y-2">
            <h1 className="text-sm">Sign in with Slack isn&apos;t available yet.</h1>
            <p className="text-xs text-muted-foreground">
              Linking Slack to Outrunner hasn&apos;t been turned on. Ask your Outrunner admin, or write to{" "}
              <a href="mailto:support@outrunner.sh" className="underline underline-offset-2">support@outrunner.sh</a>.
            </p>
          </div>
        ) : !orgs ? (
          <div className="space-y-2">
            <h1 className="text-sm">You aren&apos;t in an org yet.</h1>
          </div>
        ) : (
          <form action={startSlackLink} className="space-y-6">
            <div className="space-y-3">
              <h1 className="text-sm">Connect Slack to Outrunner</h1>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Slack user</dt>
                <dd className="font-mono">{identity.userName ? `@${identity.userName}` : identity.userId}</dd>
                <dt className="text-muted-foreground">Workspace</dt>
                <dd className="font-mono">{identity.teamName ?? identity.teamId}</dd>
                <dt className="text-muted-foreground">Outrunner</dt>
                <dd className="font-mono">{owner.githubLogin}</dd>
              </dl>
              <label className="block space-y-1 text-xs">
                <span className="text-muted-foreground">Send captures to</span>
                <select
                  name="org"
                  defaultValue={orgs.active.id}
                  className={cn("h-8 w-full rounded-md border border-input bg-transparent px-2 text-[13px] dark:bg-input/30", SELECT_OPTIONS)}
                >
                  {orgs.orgs.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-muted-foreground">
                Next, sign in with Slack as{" "}
                {identity.userName ? <span className="font-mono">@{identity.userName}</span> : "that Slack user"}.
                It finishes only if it&apos;s you.
              </p>
            </div>
            <input type="hidden" name="t" value={token} />
            <ContinueButton />
          </form>
        )}
      </div>
    </main>
  );
}
