import Link from "next/link";
import { redirect } from "next/navigation";
import { KeyRound, Vault } from "lucide-react";
import { Suspense } from "react";

import { GitHubIcon, SlackIcon } from "@/components/brand-icons";
import { IntegrationCard } from "@/components/integration-card";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listOrgInstallations } from "@/lib/db/github-installations";
import { orgSecretIntegrations } from "@/lib/db/secret-sync";
import { orgSlack } from "@/lib/db/slack-org";
import { githubAppConfig } from "@/lib/github/app";
import { getOrgContext } from "@/lib/orgs/server";
import { slackInstallUrl } from "@/lib/slack/sign-in";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/**
 * Settings → Org → Integrations: the services the org connects for its
 * agents and automations (GitHub, Slack, and Doppler and Infisical for
 * projects' secrets), whether each is connected, and the
 * way to install or configure it. Each member's own Slack account is under
 * Account → Connections.
 */
export default function OrgIntegrations() {
  return (
    <Suspense fallback={<SettingsLoading title="Integrations" />}>
      <IntegrationsSection />
    </Suspense>
  );
}

async function IntegrationsSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org/integrations");
  const context = await getOrgContext().catch(() => undefined);
  const org = context?.active;
  if (!org) {
    return (
      <section className="space-y-6">
        <h1 className="text-lg font-semibold text-foreground">Integrations</h1>
        <p className="text-sm text-muted-foreground">Couldn&apos;t load your orgs. Reload the page to try again.</p>
      </section>
    );
  }
  const admin = org.role === "admin";
  const [installations, slack, secrets] = await Promise.all([
    // What's recorded counts whether or not this server can install more.
    listOrgInstallations(org.id).catch(() => []),
    orgSlack(org.id).catch(() => null),
    orgSecretIntegrations(org.id).catch(() => ({ doppler: null, infisical: null })),
  ]);
  const github = installations.filter((i) => !i.suspended).map((i) => i.accountLogin);
  const slackTeams = (slack?.workspaces ?? []).filter((w) => w.installed).map((w) => w.teamName ?? w.teamId);
  const install = slackInstallUrl();

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Connect the services {org.name}&apos;s agents and automations work with.
        </p>
        <Link href="/settings/integrations" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          View personal connections
        </Link>
      </div>

      <div className="grid grid-cols-1 overflow-hidden rounded-lg border border-border/60 sm:grid-cols-2 [&>*]:border-border/60 sm:[&>*:nth-child(odd)]:border-r">
        <IntegrationCard
          icon={<GitHubIcon />}
          name="GitHub"
          description="Push branches, open pull requests, run automations."
          connected={github.length ? github.join(", ") : null}
          action={
            github.length
              ? { kind: "configure", href: "/settings/org/github" }
              : admin && githubAppConfig()
                ? { kind: "install", href: "/api/github/app/install", external: true }
                : null
          }
        />
        <IntegrationCard
          icon={<SlackIcon />}
          name="Slack"
          description="Mention @Outrunner in any channel."
          connected={slackTeams.length ? slackTeams.join(", ") : null}
          action={
            slackTeams.length
              ? { kind: "configure", href: "/settings/org/slack" }
              : install
                ? { kind: "install", href: install, external: true }
                : null
          }
        />
        <IntegrationCard
          icon={<KeyRound />}
          name="Doppler"
          description="Sync a Doppler config's secrets into projects' sessions."
          connected={secrets.doppler?.label ?? null}
          action={secrets.doppler || admin ? { kind: secrets.doppler ? "configure" : "connect", href: "/settings/org/integrations/doppler" } : null}
        />
        <IntegrationCard
          icon={<Vault />}
          name="Infisical"
          description="Sync Infisical secrets into projects' sessions, and its CLI."
          connected={secrets.infisical?.label ?? null}
          action={
            secrets.infisical || admin ? { kind: secrets.infisical ? "configure" : "connect", href: "/settings/org/integrations/infisical" } : null
          }
        />
      </div>
    </section>
  );
}
