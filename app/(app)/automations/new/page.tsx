import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AutomationEditor } from "@/components/automation-editor";
import { AutomationLoading } from "@/components/automations-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { orgAppCoverage } from "@/lib/automations/coverage";
import type { AppCoverage } from "@/lib/automations/rules";
import { automationTemplate, CODE_REVIEW_TEMPLATE_ID } from "@/lib/automations/templates";
import { automationSettingsOrDefault } from "@/lib/db/automation-settings";
import { listOrgRepos, orgMissionChoices } from "@/lib/db/automations";
import { getOrgContext } from "@/lib/orgs/server";

type SearchParams = Promise<{ template?: string }>;

/** Opening the new-automation form never waits on the server: the build checks
 *  it, blank and from a template. The cookies are the app layout's
 *  (lib/nav/sidebar.ts), named here rather than imported because a segment
 *  config is read by static analysis. */
export const unstable_instant = {
  prefetch: "static",
  samples: [
    {
      searchParams: { template: null },
      cookies: [
        { name: "sidebar-collapsed", value: null },
        { name: "sidebar-folded", value: null },
        { name: "sidebar-grouping", value: null },
        { name: "get-started-skipped", value: null },
        { name: "outrunner_org", value: null },
      ],
    },
    {
      searchParams: { template: "code-review" },
      cookies: [
        { name: "sidebar-collapsed", value: null },
        { name: "sidebar-folded", value: null },
        { name: "sidebar-grouping", value: null },
        { name: "get-started-skipped", value: null },
        { name: "outrunner_org", value: null },
      ],
    },
  ],
};

/** A new automation of the org the app is showing: blank, or from a template
 *  (`?template=code-review`). Its admins make them. */
export default function NewAutomationPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<AutomationLoading />}>
      <NewAutomation searchParams={searchParams} />
    </Suspense>
  );
}

async function NewAutomation({ searchParams }: { searchParams: SearchParams }) {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/automations");
  const context = await getOrgContext().catch(() => undefined);
  if (!context || context.active.role !== "admin") redirect("/automations");
  const { active } = context;
  const template = automationTemplate((await searchParams).template);
  const [repos, settings, missions] = await Promise.all([
    listOrgRepos(active.id),
    automationSettingsOrDefault(active.id),
    orgMissionChoices(active.id).catch(() => []),
  ]);
  // Coverage only flags repositories: without it, the editor still works.
  const coverage: Record<string, AppCoverage> = await orgAppCoverage(active.id, repos).catch((error: unknown) => {
    console.error("Automation: could not read the GitHub App's coverage", error);
    return {};
  });
  return (
    <AutomationEditor
      orgId={active.id}
      draft={{
        id: null,
        name: template?.name ?? "",
        template: template?.id ?? null,
        prompt: template?.prompt ?? "",
        triggers: template?.triggers ?? ["pull_request.opened"],
        schedules: [],
        reviewers: [],
        labels: [],
        limits: { maxRuns: null, archiveWhenDone: false, debounceSeconds: 0, sessionMode: "new" },
        archived: false,
        runsUsed: null,
        // From a template: every repository the GitHub App can post on, ticked
        // already, so turning it on is one Save. Only those known to be
        // ("installed"): with no coverage at all (no App, or it couldn't be
        // read) none is ticked, though the editor still lists them all.
        projectIds: template ? repos.filter((r) => coverage[r.fullName] === "installed").map((r) => r.projectId) : [],
        // Code Review is every repository's, those to come too.
        coverNewRepos: template?.id === CODE_REVIEW_TEMPLATE_ID,
        enabled: true,
        runsAs: null,
      }}
      repos={repos}
      coverage={coverage}
      byConnector={!active.personal}
      onHarness={settings.onHarness}
      webhook={null}
      missions={missions}
      editable
    />
  );
}
