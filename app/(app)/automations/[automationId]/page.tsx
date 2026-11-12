import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { AutomationEditor } from "@/components/automation-editor";
import { AutomationLoading } from "@/components/automations-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { orgAppCoverage } from "@/lib/automations/coverage";
import type { AppCoverage } from "@/lib/automations/rules";
import { webhookPathOf } from "@/lib/db/automation-webhooks";
import { getAutomation, listOrgRepos } from "@/lib/db/automations";
import { isUuid } from "@/lib/ids";
import { getOrgContext } from "@/lib/orgs/server";

type Params = Promise<{ automationId: string }>;

/** Opening an automation never waits on the server: the build checks it, on a
 *  sample automation opened from the list. The cookies are the app layout's
 *  (lib/nav/sidebar.ts), named here rather than imported because a segment
 *  config is read by static analysis. */
export const unstable_instant = {
  prefetch: "static",
  samples: [
    {
      params: { automationId: "00000000-0000-0000-0000-000000000000" },
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

/** One automation of the org the app is showing: its admins change it, its
 *  members see it. */
export default function AutomationPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<AutomationLoading />}>
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
        target: automation.target,
      }}
      fixedMission={
        automation.target.kind === "mission"
          ? { id: automation.target.missionId, title: automation.target.missionTitle ?? "Mission", projectId: automation.repos[0]?.projectId ?? "" }
          : null
      }
      repos={repos}
      coverage={coverage}
      byConnector={!active.personal}
      editable={admin}
      webhook={webhook}
    />
  );
}
