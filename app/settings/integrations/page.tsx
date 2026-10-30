import { PageHeader } from "@/components/page-layout";

import Link from "next/link";
import { GitHubConnectionSection } from "@/components/github-connection-section";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { unlinkSlack } from "@/app/settings/integrations/actions";
import { SettingsLoading } from "@/components/settings-loading";
import { Button } from "@/components/ui/button";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listSlackLinks, type SlackLink } from "@/lib/db/slack-links";
import { optionalEnv } from "@/lib/env";

/** How the last Sign in with Slack ended (app/api/integrations/slack/oauth). */
const SLACK_RESULTS: Record<string, string> = {
  linked: "Slack connected. Try the shortcut again.",
  installed: "The Slack app is installed. Use /triage or the message shortcut once to connect your account.",
  mismatch: "You signed in to Slack as someone other than the Slack user the link was for. Nothing was connected.",
  expired: "That link expired or was opened elsewhere. Run /triage in Slack for a new one.",
  cancelled: "Slack sign-in was cancelled.",
  failed: "Slack didn't finish the sign-in. Please try again.",
  unavailable: "Sign in with Slack isn't set up on this deployment.",
};

/** Connections: your own accounts, connected to an org (your Slack user, and
 *  the CLI). The org's own are under Org → Integrations. */
export default function IntegrationsSettings({
  searchParams,
}: {
  searchParams: Promise<{ slack?: string; link_error?: string }>;
}) {
  return (
    <Suspense fallback={<SettingsLoading title="Connections" />}>
      <IntegrationsSection searchParams={searchParams} />
    </Suspense>
  );
}

async function IntegrationsSection({ searchParams }: { searchParams: Promise<{ slack?: string; link_error?: string }> }) {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin");
  const { slack, link_error: linkError } = await searchParams;
  const enabled = Boolean(optionalEnv("SLACK_SIGNING_SECRET"));
  const links = await listSlackLinks(owner.id).catch((error: unknown): SlackLink[] => {
    console.error("Settings: could not load Slack links", error);
    return [];
  });

  return (
    <section className="space-y-8">
      <div className="space-y-1">
        <PageHeader title={"Connections"} />
        <Link href="/settings/org/integrations" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          View your org&apos;s integrations
        </Link>
      </div>

      <GitHubConnectionSection userId={owner.id} login={owner.githubLogin} />
      {linkError && <p role="alert" className="text-sm text-destructive">{linkError === "identity_already_exists" ? "That GitHub account is already linked to another Outrunner account. Connect a different account, or sign in with GitHub to use it." : "GitHub could not be connected. Please try again."}</p>}

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Slack</h2>
        <p className="text-sm text-muted-foreground">
          Send a message to your triage with its <span className="text-foreground">⋯ → Send to Outrunner triage</span>{" "}
          shortcut, or type <code className="font-mono">/triage what needs doing</code>. Another message
          from the same thread becomes a note on the same item.
        </p>
        {!enabled ? (
          <p className="text-xs text-muted-foreground">
            Slack isn&apos;t set up on this deployment yet: see <code className="font-mono">docs/slack-app.md</code>.
          </p>
        ) : links.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Not connected. Use the shortcut or <code className="font-mono">/triage</code> once in Slack: the reply has
            a link where you pick the org and sign in with Slack to connect.
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border/60">
            {links.map((link) => (
              <li key={`${link.teamId}/${link.userId}`} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="text-sm">
                  <span className="font-mono">{link.userName ? `@${link.userName}` : link.userId}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    in {link.teamName ?? link.teamId} → {link.orgName ?? "an org"}&apos;s triage
                  </span>
                </div>
                <form action={unlinkSlack}>
                  <input type="hidden" name="team" value={link.teamId} />
                  <input type="hidden" name="user" value={link.userId} />
                  <Button type="submit" size="sm" variant="ghost">
                    Unlink
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {slack && SLACK_RESULTS[slack] && (
          <p className={slack === "linked" || slack === "installed" ? "text-xs text-foreground" : "text-xs text-destructive"}>
            {SLACK_RESULTS[slack]}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Terminal</h2>
        <p className="text-sm text-muted-foreground">
          After <code className="font-mono">outrunner login</code>, capture from the terminal with{" "}
          <code className="font-mono">outrunner triage &quot;fix the flaky login test&quot;</code>. It goes to your
          personal org&apos;s triage unless you pass <code className="font-mono">--org &lt;name&gt;</code>. Scripts can
          post to <code className="font-mono">/api/triage/items?org=&lt;name&gt;</code> with the same token.
        </p>
      </div>
    </section>
  );
}
