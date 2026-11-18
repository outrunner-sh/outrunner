import { notFound, redirect } from "next/navigation";

import { AutomationEditor } from "@/components/automation-editor";
import { automationSettingsOrDefault } from "@/lib/db/automation-settings";
import { triggerPageContext } from "@/lib/missions/trigger-pages";

type Params = Promise<{ id: string }>;

/** A new trigger for a Mission: the automation editor, its destination this
 *  Mission. Someone with write on its project makes one. */
export default async function NewMissionTriggerPage({ params }: { params: Params }) {
  const { id } = await params;
  const context = await triggerPageContext(id);
  if (context === "signedOut") redirect(`/signin?next=/missions/${id}/triggers/new`);
  if (!context) notFound();
  if (!context.canWrite) redirect(`/missions/${id}/triggers`);
  const mission = { id: context.mission.id, title: context.mission.title ?? "Mission", projectId: context.mission.projectId };
  return (
    <AutomationEditor
      orgId={context.mission.orgId}
      draft={{
        id: null,
        name: "",
        template: null,
        prompt: "",
        triggers: ["schedule"],
        schedules: [],
        reviewers: [],
        labels: [],
        limits: { maxRuns: null, archiveWhenDone: false, debounceSeconds: 0, sessionMode: "new" },
        archived: false,
        runsUsed: null,
        projectIds: [mission.projectId],
        coverNewRepos: false,
        enabled: true,
        runsAs: null,
        target: { kind: "mission", missionId: mission.id, watch: null, linearTeamIds: [] },
      }}
      repos={[]}
      coverage={{}}
      byConnector={!context.personal}
      onHarness={(await automationSettingsOrDefault(context.mission.orgId)).onHarness}
      webhook={null}
      fixedMission={mission}
      place={{
        create: `/api/missions/${mission.id}/triggers`,
        itemBase: `/api/missions/${mission.id}/triggers`,
        back: `/missions/${mission.id}/triggers`,
        backLabel: "Triggers",
      }}
      editable
    />
  );
}
