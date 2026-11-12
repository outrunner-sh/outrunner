import { PageHeader } from "@/components/page-layout";

import Link from "next/link";
import { redirect } from "next/navigation";
import { KeyRound, Vault } from "lucide-react";
import { Suspense } from "react";

import { GitHubIcon, JiraIcon, LinearIcon, SlackIcon } from "@/components/brand-icons";
import { IntegrationCard } from "@/components/integration-card";
import { deploymentCard } from "@/lib/integrations/card";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listOrgInstallations } from "@/lib/db/github-installations";
import { orgSecretIntegrations } from "@/lib/db/secret-sync";
import { orgSlack } from "@/lib/db/slack-org";
import { orgTrackers } from "@/lib/db/trackers";
import { githubAppConfig } from "@/lib/github/app";
import { getOrgContext } from "@/lib/orgs/server";
import { jiraConfig } from "@/lib/trackers/jira";
import { linearConfig } from "@/lib/trackers/linear";
import { slackInstallUrl } from "@/lib/slack/sign-in";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/**
 * Settings → Org → Integrations: the services the org connects for its
 * agents and automations (GitHub, Slack, Linear, Jira, and Doppler and Infisical for
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
        <PageHeader title={"Integrations"} />
        <p className="text-sm text-muted-foreground">Couldn&apos;t load your orgs. Reload the page to try again.</p>
      </section>
    );
  }
  const admin = org.role === "admin";
  const [installations, slack, secrets, linear, jira] = await Promise.all([
    // What's recorded counts whether or not this server can install more.
    listOrgInstallations(org.id).catch(() => []),
    orgSlack(org.id).catch(() => null),
    orgSecretIntegrations(org.id).catch(() => ({ doppler: null, infisical: null })),
    orgTrackers(org.id, "linear").catch(() => []),
    orgTrackers(org.id, "jira").catch(() => []),
  ]);
  const github = installations.filter((i) => !i.suspended).map((i) => i.accountLogin);
  const slackTeams = (slack?.workspaces ?? []).filter((w) => w.installed).map((w) => w.teamName ?? w.teamId);
  const install = slackInstallUrl();
  // Each needs an app registered for this deployment before anyone can install it.
  const githubCard = deploymentCard({ connected: github.length > 0, admin, configureHref: "/settings/org/github", installHref: githubAppConfig() ? "/api/github/app/install" : null, external: true });
  const slackCard = deploymentCard({ connected: slackTeams.length > 0, admin, configureHref: "/settings/org/slack", installHref: install, external: true, installableByMembers: true });
  const linearCard = deploymentCard({ connected: linear.length > 0, admin, configureHref: "/settings/org/linear", installHref: linearConfig() ? "/settings/org/linear" : null });
  const jiraCard = deploymentCard({ connected: jira.length > 0, admin, configureHref: "/settings/org/jira", installHref: jiraConfig() ? "/settings/org/jira" : null });

  return (
    <section className="@container space-y-6">
      <div className="space-y-1">
        <PageHeader title={"Integrations"} />
        <p className="text-sm text-muted-foreground">
          Connect the services {org.name}&apos;s agents and automations work with.
        </p>
        <Link href="/settings/integrations" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          View personal connections
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 @md:grid-cols-2">
        <IntegrationCard
          icon={<GitHubIcon />}
          name="GitHub"
          description="Push branches, open pull requests, run automations."
          connected={github.length ? github.join(", ") : null}
          note={githubCard.note}
          action={githubCard.action}
        />
        <IntegrationCard
          icon={<SlackIcon />}
          name="Slack"
          description="Mention @Outrunner in any channel."
          connected={slackTeams.length ? slackTeams.join(", ") : null}
          note={slackCard.note}
          action={slackCard.action}
        />
        <IntegrationCard
          icon={<LinearIcon />}
          name="Linear"
          description="File issues to Triage by rules, and keep them in step."
          connected={linear.length ? linear.map((l) => l.name ?? l.externalId).join(", ") : null}
          problem={linear.some((l) => l.disconnected) ? "Disconnected: rules have stopped. Reconnect it." : null}
          note={linearCard.note}
          action={linearCard.action}
        />
        <IntegrationCard
          icon={<JiraIcon />}
          name="Jira"
          description="File issues to Triage by rules, and keep them in step."
          connected={jira.length ? jira.map((j) => j.name ?? j.externalId).join(", ") : null}
          problem={jira.some((j) => j.disconnected) ? "Disconnected: rules have stopped. Reconnect it." : null}
          note={jiraCard.note}
          action={jiraCard.action}
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
