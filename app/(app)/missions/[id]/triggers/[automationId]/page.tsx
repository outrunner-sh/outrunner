import { notFound, redirect } from "next/navigation";

import { AutomationEditor } from "@/components/automation-editor";
import { webhookPathOf } from "@/lib/db/automation-webhooks";
import { getAutomation } from "@/lib/db/automations";
import { isUuid } from "@/lib/ids";
import { triggerPageContext } from "@/lib/missions/trigger-pages";

type Params = Promise<{ id: string; automationId: string }>;

/** One of a Mission's triggers: changed by someone with write on its
 *  project, seen by anyone who can read it. */
export default async function MissionTriggerPage({ params }: { params: Params }) {
  const { id, automationId } = await params;
  const context = await triggerPageContext(id);
  if (context === "signedOut") redirect(`/signin?next=/missions/${id}/triggers/${automationId}`);
  if (!context || !isUuid(automationId)) notFound();
  const automation = await getAutomation(context.mission.orgId, automationId);
  if (!automation || automation.target.kind !== "mission" || automation.target.missionId !== context.mission.id) notFound();
  const mission = { id: context.mission.id, title: context.mission.title ?? "Mission", projectId: context.mission.projectId };
  return (
    <AutomationEditor
      key={automation.id}
      orgId={context.mission.orgId}
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
        projectIds: [mission.projectId],
        enabled: automation.enabled,
        runsAs: automation.runsAs ? automation.runsAs.login : null,
        target: automation.target,
      }}
      repos={[]}
      coverage={{}}
      byConnector={!context.personal}
      // Its URL is a secret: for whoever may change the trigger.
      webhook={context.canWrite && automation.triggers.includes("webhook") ? await webhookPathOf(context.mission.orgId, automation.id).catch(() => null) : null}
      fixedMission={mission}
      place={{
        create: `/api/missions/${mission.id}/triggers`,
        itemBase: `/api/missions/${mission.id}/triggers`,
        back: `/missions/${mission.id}/triggers`,
        backLabel: "Triggers",
      }}
      editable={context.canWrite}
    />
  );
}
