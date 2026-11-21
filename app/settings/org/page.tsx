import { PageHeader } from "@/components/page-layout";

import { redirect } from "next/navigation";
import { Suspense } from "react";

import OrgDefaults from "@/app/settings/org/defaults/page";
import { AutomationRunSettings } from "@/components/automation-run-settings";
import { OrgJoinSettings } from "@/components/org-join-settings";
import { OrgGeneralSettings } from "@/components/org-settings";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { automationSettingsOrDefault } from "@/lib/db/automation-settings";
import { sourceOrgInstallations } from "@/lib/db/github-installations";
import { getJoinViaGithub } from "@/lib/db/org-members";
import { orgDomain } from "@/lib/db/orgs";
import { getOrgContext } from "@/lib/orgs/server";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Settings → Org: the org the app is showing, its name, domain and your role. */
export default function OrgSettings() {
  return (
    <Suspense fallback={<SettingsLoading title="Org" />}>
      <OrgSection />
    </Suspense>
  );
}

async function OrgSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org");
  const context = await getOrgContext().catch((error: unknown) => {
    console.error("Settings → Org: could not load orgs", error);
    return undefined;
  });
  if (context === undefined) {
    return (
      <section className="space-y-6">
        <PageHeader title={"Org"} />
        <p className="text-sm text-muted-foreground">Couldn&apos;t load your orgs. Reload the page to try again.</p>
      </section>
    );
  }
  if (!context) {
    return (
      <section className="space-y-6">
        <PageHeader title={"Org"} />
        <p className="text-sm text-muted-foreground">Orgs aren&apos;t set up on this Outrunner yet.</p>
      </section>
    );
  }
  const { active } = context;
  const [domain, automations, join] = await Promise.all([
    orgDomain(active.id).catch(() => null),
    automationSettingsOrDefault(active.id),
    joinSettings(active.id),
  ]);
  return (
    <div className="space-y-10">
      <OrgGeneralSettings org={active} domain={domain} />
      {join && <OrgJoinSettings org={active} initial={join.enabled} githubOrgs={join.githubOrgs} />}
      <AutomationRunSettings org={active} initial={automations} />
      <OrgDefaults />
    </div>
  );
}

/** An org's joining through GitHub, as the page shows it: none, rather
 *  than no page, when it can't be read. */
async function joinSettings(orgId: string): Promise<{ enabled: boolean; githubOrgs: string[] } | null> {
  try {
    const [enabled, sources] = await Promise.all([getJoinViaGithub(orgId), sourceOrgInstallations({ orgId })]);
    return { enabled, githubOrgs: [...new Set(sources.map((s) => s.githubOrg))].sort() };
  } catch (error) {
    console.error(`Settings → Org: could not read org ${orgId}'s join settings`, error);
    return null;
  }
}
