import { PageHeader } from "@/components/page-layout";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { JiraIcon } from "@/components/brand-icons";
import { TrackerSettings } from "@/components/tracker-settings";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listOrgProjects } from "@/lib/db/org-access";
import { getOrgContext } from "@/lib/orgs/server";
import { jiraConfig } from "@/lib/trackers/jira";
import { trackersWithStoppedRules } from "@/lib/trackers/org-settings";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** How the last trip to Atlassian ended (app/api/integrations/jira/callback). */
const RESULTS: Record<string, string> = {
  installed: "Jira is connected. Connect a project to start.",
  not_admin: "Only the org's admins can connect Jira.",
  expired: "That link expired or was opened elsewhere. Try again.",
  cancelled: "Atlassian's sign-in was cancelled.",
  many_sites: "That Jira account can reach more than one site. Authorize with a service account on just the one.",
  site_taken: "That site is already connected with another Jira account, and only that account can add your org. Ask whoever can sign in as it, or have the site's Jira admin clear it.",
  not_site_admin: "Jira says that account doesn't administer this site, so nothing changed.",
  reclaimed: "The site is cleared: whoever held it is disconnected, and no org is on it. Install, authorizing as your service account, to connect it.",
  failed: "Jira didn't finish connecting. Please try again.",
  unavailable: "Jira isn't set up on this deployment yet: see docs/jira-app.md.",
};

/**
 * Settings → Org → Integrations → Jira: the sites the org uses, its connected
 * projects, and each project's triage rules. Every member sees them; only
 * the org's admins change them.
 */
export default function OrgJiraSettings({ searchParams }: { searchParams: Promise<{ jira?: string; site?: string }> }) {
  return (
    <Suspense fallback={<SettingsLoading title="Jira" />}>
      <JiraSection searchParams={searchParams} />
    </Suspense>
  );
}

async function JiraSection({ searchParams }: { searchParams: Promise<{ jira?: string; site?: string }> }) {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org/jira");
  const { jira: result, site } = await searchParams;
  const context = await getOrgContext().catch(() => undefined);
  const org = context?.active;
  const [trackers, projects] = org
    ? await Promise.all([trackersWithStoppedRules(org.id, "jira").catch(() => null), listOrgProjects(org.id).catch(() => [])])
    : [null, []];

  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <Link href="/settings/org/integrations" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          Integrations
        </Link>
        <div className="flex items-center gap-3">
          <JiraIcon className="size-7" />
          <div>
            <PageHeader title={"Jira"} />
            <p className="text-sm text-muted-foreground">
              Issues that match a project&apos;s rules land in Triage, and stay in step with Jira. Assign an issue to
              Outrunner&apos;s account, or mention it, to start a session.
            </p>
          </div>
        </div>
      </div>
      {result && RESULTS[result] && (
        <p className={result === "installed" || result === "reclaimed" ? "text-xs text-foreground" : "text-xs text-destructive"}>{RESULTS[result]}</p>
      )}
      {result === "site_taken" && site && org?.role === "admin" && (
        <p className="text-xs text-muted-foreground">
          <a className="underline underline-offset-4" href={`/api/integrations/jira/reclaim?site=${encodeURIComponent(site)}`}>
            Clear it as the site&apos;s Jira admin
          </a>
          : sign in to Atlassian as yourself. This disconnects whoever holds it, and takes every org off it. Items already filed
          stay.
        </p>
      )}
      {!org || !trackers ? (
        <p className="text-sm text-muted-foreground">Couldn&apos;t load Jira. Reload the page to try again.</p>
      ) : (
        <TrackerSettings
          provider="jira"
          orgId={org.id}
          admin={org.role === "admin"}
          available={jiraConfig() !== null}
          trackers={trackers}
          projects={projects}
        />
      )}
    </section>
  );
}
