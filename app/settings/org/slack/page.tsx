import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { SlackIcon } from "@/components/brand-icons";
import { SettingsLoading } from "@/components/settings-loading";
import { Button } from "@/components/ui/button";
import { getOwnerSafe } from "@/lib/auth/owner";
import { orgSlack } from "@/lib/db/slack-org";
import { getOrgContext } from "@/lib/orgs/server";
import { slackInstallUrl } from "@/lib/slack/sign-in";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/**
 * Settings → Org → Integrations → Slack: the Slack workspaces the org works
 * from (and whether Outrunner's bot is installed in each), who has connected
 * their Slack account to the org, and what the agent does in each channel.
 */
export default function OrgSlackSettings() {
  return (
    <Suspense fallback={<SettingsLoading title="Slack" />}>
      <SlackSection />
    </Suspense>
  );
}

function digestLabel(c: { digest: "daily" | "weekly" | null; hour: number; tz: string }): string {
  if (!c.digest) return "No digest";
  return `${c.digest === "daily" ? "Daily" : "Weekly (Mondays)"} digest at ${String(c.hour).padStart(2, "0")}:00 ${c.tz}`;
}

async function SlackSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org/slack");
  const context = await getOrgContext().catch(() => undefined);
  const org = context?.active;
  const slack = org ? await orgSlack(org.id).catch(() => null) : null;
  const install = slackInstallUrl();
  const admin = org?.role === "admin";

  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <Link href="/settings/org/integrations" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          Integrations
        </Link>
        <div className="flex items-center gap-3">
          <SlackIcon className="size-7" />
          <div>
            <h1 className="text-lg font-semibold text-foreground">Slack</h1>
            <p className="text-sm text-muted-foreground">
              Mention @Outrunner in a channel, or DM it. It asks what it must, and a click starts the session: the
              thread and the session stay in step.
            </p>
          </div>
        </div>
      </div>

      {!slack ? (
        <p className="text-sm text-muted-foreground">Couldn&apos;t load Slack. Reload the page to try again.</p>
      ) : (
        <>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-foreground">Slack workspaces</h2>
              {admin && install && (
                <Button asChild size="sm" variant="outline">
                  <a href={install}>{slack.workspaces.some((w) => w.installed) ? "Reinstall" : "Install"}</a>
                </Button>
              )}
            </div>
            {slack.workspaces.length === 0 ? (
              <p className="text-xs text-muted-foreground">None yet. Install the app, then mention @Outrunner in Slack.</p>
            ) : (
              <ul className="divide-y divide-border/60 rounded-md border border-border/60">
                {slack.workspaces.map((w) => (
                  <li key={w.teamId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span>{w.teamName ?? w.teamId}</span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={w.installed ? "size-1.5 rounded-full bg-emerald-500" : "size-1.5 rounded-full bg-amber-500"} />
                      {w.installed ? "Installed" : "Not installed through Outrunner: reinstall so the agent can post"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-3">
            <h2 className="text-sm font-medium text-foreground">Connected members</h2>
            <p className="text-xs text-muted-foreground">
              Each person connects their own Slack account once: the first time they mention @Outrunner, its reply
              has the link. Their own connection is under{" "}
              <Link href="/settings/integrations" className="underline underline-offset-4">
                Account → Connections
              </Link>
              .
            </p>
            {slack.members.length === 0 ? (
              <p className="text-xs text-muted-foreground">No one yet.</p>
            ) : (
              <ul className="divide-y divide-border/60 rounded-md border border-border/60">
                {slack.members.map((m) => (
                  <li key={`${m.teamId}/${m.slackUser}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="font-mono">{m.slackUser}</span>
                    <span className="text-xs text-muted-foreground">{m.outrunnerName ?? "an Outrunner member"}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-3">
            <h2 className="text-sm font-medium text-foreground">Channels</h2>
            <p className="text-xs text-muted-foreground">
              An admin changes these by asking @Outrunner in the channel: &quot;watch this channel&quot;, &quot;post a
              daily digest here at 9am Asia/Kolkata&quot;, &quot;stop the digest&quot;.
            </p>
            {slack.channels.length === 0 ? (
              <p className="text-xs text-muted-foreground">No channel is watched or gets a digest yet.</p>
            ) : (
              <ul className="divide-y divide-border/60 rounded-md border border-border/60">
                {slack.channels.map((c) => (
                  <li key={`${c.teamId}/${c.channelId}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs">{c.channelId}</span>
                      <a
                        href={`https://app.slack.com/client/${c.teamId}/${c.channelId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                      >
                        Open in Slack
                      </a>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {c.watch ? "Watched" : "Not watched"} · {digestLabel(c)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
