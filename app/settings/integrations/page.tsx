import { redirect } from "next/navigation";
import { Suspense } from "react";

import { unlinkSlack } from "@/app/settings/integrations/actions";
import { SettingsLoading } from "@/components/settings-loading";
import { Button } from "@/components/ui/button";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listSlackLinks, type SlackLink } from "@/lib/db/slack-links";
import { optionalEnv } from "@/lib/env";

/** Integrations: where triage captures come from — Slack, and the CLI. */
export default function IntegrationsSettings({
  searchParams,
}: {
  searchParams: Promise<{ slack?: string }>;
}) {
  return (
    <Suspense fallback={<SettingsLoading title="Integrations" />}>
      <IntegrationsSection searchParams={searchParams} />
    </Suspense>
  );
}

async function IntegrationsSection({ searchParams }: { searchParams: Promise<{ slack?: string }> }) {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin");
  const { slack } = await searchParams;
  const enabled = Boolean(optionalEnv("SLACK_SIGNING_SECRET"));
  const links = await listSlackLinks(owner.id).catch((error: unknown): SlackLink[] => {
    console.error("Settings: could not load Slack links", error);
    return [];
  });

  return (
    <section className="space-y-8">
      <h1 className="text-lg font-semibold text-foreground">Integrations</h1>

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Slack</h2>
        <p className="text-sm text-muted-foreground">
          Send a message to your triage with its <span className="text-foreground">⋯ → Send to Outrunner triage</span>{" "}
          shortcut, or type <code className="font-mono">/triage [owner/repo] what needs doing</code>. Another message
          from the same thread becomes a note on the same item.
        </p>
        {!enabled ? (
          <p className="text-xs text-muted-foreground">
            Slack isn&apos;t set up on this deployment yet: see <code className="font-mono">docs/slack-app.md</code>.
          </p>
        ) : links.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Not connected. Use the shortcut or <code className="font-mono">/triage</code> once in Slack: the reply has
            a link that connects your Slack user here.
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border/60">
            {links.map((link) => (
              <li key={`${link.teamId}/${link.userId}`} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="text-sm">
                  <span className="font-mono">{link.userName ? `@${link.userName}` : link.userId}</span>
                  <span className="text-muted-foreground"> in {link.teamName ?? link.teamId}</span>
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
        {slack === "linked" && <p className="text-xs text-foreground">Slack connected. Try the shortcut again.</p>}
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Terminal</h2>
        <p className="text-sm text-muted-foreground">
          After <code className="font-mono">outrunner login</code>, capture from the terminal with{" "}
          <code className="font-mono">outrunner triage &quot;fix the flaky login test&quot;</code>. Scripts can post
          to <code className="font-mono">/api/triage/items</code> with the same token.
        </p>
      </div>
    </section>
  );
}
