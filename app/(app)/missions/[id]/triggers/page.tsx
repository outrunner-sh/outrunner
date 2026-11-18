import { notFound, redirect } from "next/navigation";

import { MissionTriggers } from "@/components/missions/mission-triggers";
import { listRuns } from "@/lib/db/automation-runs";
import { missionAutomations } from "@/lib/db/automations";
import { triggerPageContext } from "@/lib/missions/trigger-pages";

type Params = Promise<{ id: string }>;

/** A Mission's triggers and their run history (docs/missions.md, "Triggers"),
 *  reached from its header. */
export default async function MissionTriggersPage({ params }: { params: Params }) {
  const { id } = await params;
  const context = await triggerPageContext(id);
  if (context === "signedOut") redirect(`/signin?next=/missions/${id}/triggers`);
  if (!context) notFound();
  const automations = await missionAutomations(context.mission.orgId, context.mission.id);
  const runs = automations.length ? await listRuns(context.mission.orgId, 50, undefined, undefined, automations.map((a) => a.id)) : [];
  return (
    <MissionTriggers
      mission={{ id: context.mission.id, title: context.mission.title ?? "Mission" }}
      orgId={context.mission.orgId}
      automations={automations}
      runs={runs}
      isOwner={context.isOwner}
      canWrite={context.canWrite}
      admin={context.admin}
      byConnector={!context.personal}
    />
  );
}
