import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { AutomationEditor } from "@/components/automation-editor";
import { getOwnerSafe } from "@/lib/auth/owner";
import { orgAppCoverage } from "@/lib/automations/coverage";
import type { AppCoverage } from "@/lib/automations/rules";
import { webhookPathOf } from "@/lib/db/automation-webhooks";
import { getAutomation, listOrgRepos } from "@/lib/db/automations";
import { isUuid } from "@/lib/ids";
import { getOrgContext } from "@/lib/orgs/server";

type Params = Promise<{ automationId: string }>;

/** One automation of the org the app is showing: its admins change it, its
 *  members see it. */
export default function AutomationPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={null}>
      <AutomationSection params={params} />
    </Suspense>
  );
}

async function AutomationSection({ params }: { params: Params }) {
  const { automationId } = await params;
  const owner = await getOwnerSafe();
  if (!owner) redirect(`/signin?next=/automations/${automationId}`);
  if (!isUuid(automationId)) notFound();
  const context = await getOrgContext().catch(() => undefined);
  if (!context) redirect("/automations");
  const { active } = context;
  const admin = active.role === "admin";
  const [automation, repos, webhook] = await Promise.all([
    getAutomation(active.id, automationId),
    listOrgRepos(active.id),
    // Its URL is a secret: its admins' alone.
    admin
      ? webhookPathOf(active.id, automationId).catch((error: unknown) => {
          console.error("Automation: could not read its webhook", error);
          return null;
        })
      : null,
  ]);
  if (!automation) notFound();
  // Coverage only flags repositories: without it, the editor still works.
  const coverage: Record<string, AppCoverage> = await orgAppCoverage(active.id, repos).catch((error: unknown) => {
    console.error("Automation: could not read the GitHub App's coverage", error);
    return {};
  });
  return (
    <AutomationEditor
      key={automation.id}
      orgId={active.id}
      draft={{
        id: automation.id,
        name: automation.name,
        template: automation.template,
        prompt: automation.prompt,
        triggers: automation.triggers,
        schedules: automation.schedules,
        reviewers: automation.reviewers,
        labels: automation.labels,
        limits: {
          maxRuns: automation.maxRuns,
          archiveWhenDone: automation.archiveWhenDone,
          debounceSeconds: automation.debounceSeconds,
          sessionMode: automation.sessionMode,
        },
        archived: automation.archived,
        runsUsed: automation.runsUsed,
        projectIds: automation.repos.map((r) => r.projectId),
        enabled: automation.enabled,
        // Its runner's login, "" when it can't be told (no GitHub login on
        // record), null once they're no longer in the org.
        runsAs: automation.runsAs ? automation.runsAs.login : null,
      }}
      repos={repos}
      coverage={coverage}
      byConnector={!active.personal}
      editable={admin}
      webhook={webhook}
    />
  );
}
