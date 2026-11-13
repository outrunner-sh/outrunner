import { GitLabConnectionCard } from "@/components/gitlab-connection-card";
import { gitLabConnection } from "@/lib/db/gitlab-connections";
import { PageHeader } from "@/components/page-layout";

import Link from "next/link";
import { GitHubConnectionSection } from "@/components/github-connection-section";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { unlinkSlack, unlinkTracker } from "@/app/settings/integrations/actions";
import { SettingsLoading } from "@/components/settings-loading";
import { Button } from "@/components/ui/button";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listSlackLinks, type SlackLink } from "@/lib/db/slack-links";
import { listTrackerLinks, type TrackerLink } from "@/lib/db/trackers";
import { optionalEnv } from "@/lib/env";
import { jiraConfig } from "@/lib/trackers/jira";
import { linearConfig } from "@/lib/trackers/linear";

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

/** How the last Jira sign-in ended (app/api/integrations/jira/callback). */
const JIRA_RESULTS: Record<string, string> = {
  linked: "Jira linked.",
  not_installed: "Your Jira site isn't connected to Outrunner yet: an org admin connects it under Org → Integrations.",
  not_member: "You aren't in an org that uses that Jira site, so there's nothing to link.",
  expired: "That link expired or was opened elsewhere. Try again.",
  cancelled: "Atlassian's sign-in was cancelled.",
  failed: "Jira didn't finish the sign-in. Please try again.",
  unavailable: "Jira isn't set up on this deployment yet: see docs/jira-app.md.",
};

/** How the last Linear sign-in ended (app/api/integrations/linear/callback). */
const LINEAR_RESULTS: Record<string, string> = {
  linked: "Linear linked.",
  not_installed: "Your Linear workspace isn't connected to Outrunner yet: an org admin connects it under Org → Integrations.",
  not_member: "You aren't in an org that uses that Linear workspace, so there's nothing to link.",
  expired: "That link expired or was opened elsewhere. Try again.",
  cancelled: "Linear's sign-in was cancelled.",
  failed: "Linear didn't finish the sign-in. Please try again.",
  unavailable: "Linear isn't set up on this deployment yet: see docs/linear-app.md.",
};

/** Connections: your own accounts (GitHub for your repositories, your Slack
 *  user, your Linear and Jira users, and the CLI). The org's own are under
 *  Org → Integrations. */
export default function IntegrationsSettings({
  searchParams,
}: {
  searchParams: Promise<{ slack?: string; linear?: string; jira?: string; link_error?: string; github?: string }>;
}) {
  return (
    <Suspense fallback={<SettingsLoading title="Connections" />}>
      <IntegrationsSection searchParams={searchParams} />
    </Suspense>
  );
}

async function IntegrationsSection({
  searchParams,
}: {
  searchParams: Promise<{ slack?: string; linear?: string; jira?: string; link_error?: string; github?: string }>;
}) {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin");
  const { slack, linear, jira, link_error: linkError, github } = await searchParams;
  const enabled = Boolean(optionalEnv("SLACK_SIGNING_SECRET"));
  const [links, trackerLinks] = await Promise.all([
    listSlackLinks(owner.id).catch((error: unknown): SlackLink[] => {
      console.error("Settings: could not load Slack links", error);
      return [];
    }),
    listTrackerLinks(owner.id).catch((): TrackerLink[] => []),
  ]);
  const linearLinks = trackerLinks.filter((link) => link.provider === "linear");
  const jiraLinks = trackerLinks.filter((link) => link.provider === "jira");

  return (
    <section className="space-y-8">
      <div className="space-y-1">
        <PageHeader title={"Connections"} />
        <Link href="/settings/org/integrations" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          View your org&apos;s integrations
        </Link>
      </div>

      <GitHubConnectionSection userId={owner.id} login={owner.githubLogin} result={github ?? null} />
      <GitLabConnectionCard initial={await gitLabConnection(owner.id)} />
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
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Linear</h2>
          {linearConfig() && (
            <Button asChild size="sm" variant="outline">
              <a href="/api/integrations/linear/link">{linearLinks.length ? "Link another" : "Link Linear"}</a>
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Sign in to Linear as yourself, so issues and comments you write there show as yours in your org&apos;s triage.
        </p>
        {linearLinks.length === 0 ? (
          <p className="text-xs text-muted-foreground">Not linked.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border/60">
            {linearLinks.map((link) => (
              <li key={`${link.installationId}/${link.externalUserId}`} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="text-sm">
                  <span>{link.externalName ?? link.externalUserId}</span>
                  <span className="text-muted-foreground"> in {link.workspace ?? "a Linear workspace"}</span>
                </div>
                <form action={unlinkTracker}>
                  <input type="hidden" name="installation" value={link.installationId} />
                  <input type="hidden" name="user" value={link.externalUserId} />
                  <Button type="submit" size="sm" variant="ghost">
                    Unlink
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {linear && LINEAR_RESULTS[linear] && (
          <p className={linear === "linked" ? "text-xs text-foreground" : "text-xs text-destructive"}>{LINEAR_RESULTS[linear]}</p>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Jira</h2>
          {jiraConfig() && (
            <Button asChild size="sm" variant="outline">
              <a href="/api/integrations/jira/link">{jiraLinks.length ? "Link another" : "Link Jira"}</a>
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Sign in to Jira as yourself, so issues and comments you write there show as yours in your org&apos;s triage.
        </p>
        {jiraLinks.length === 0 ? (
          <p className="text-xs text-muted-foreground">Not linked.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border/60">
            {jiraLinks.map((link) => (
              <li key={`${link.installationId}/${link.externalUserId}`} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="text-sm">
                  <span>{link.externalName ?? link.externalUserId}</span>
                  <span className="text-muted-foreground"> in {link.workspace ?? "a Jira site"}</span>
                </div>
                <form action={unlinkTracker}>
                  <input type="hidden" name="installation" value={link.installationId} />
                  <input type="hidden" name="user" value={link.externalUserId} />
                  <Button type="submit" size="sm" variant="ghost">
                    Unlink
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {jira && JIRA_RESULTS[jira] && (
          <p className={jira === "linked" ? "text-xs text-foreground" : "text-xs text-destructive"}>{JIRA_RESULTS[jira]}</p>
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
