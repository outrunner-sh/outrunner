import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AutomationEditor } from "@/components/automation-editor";
import { getOwnerSafe } from "@/lib/auth/owner";
import { orgAppCoverage } from "@/lib/automations/coverage";
import type { AppCoverage } from "@/lib/automations/rules";
import { automationTemplate } from "@/lib/automations/templates";
import { listOrgRepos } from "@/lib/db/automations";
import { getOrgContext } from "@/lib/orgs/server";

type SearchParams = Promise<{ template?: string }>;

/** A new automation of the org the app is showing: blank, or from a template
 *  (`?template=code-review`). Its admins make them. */
export default function NewAutomationPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={null}>
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
  const repos = await listOrgRepos(active.id);
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
        enabled: true,
        runsAs: null,
      }}
      repos={repos}
      coverage={coverage}
      byConnector={!active.personal}
      webhook={null}
      editable
    />
  );
}
