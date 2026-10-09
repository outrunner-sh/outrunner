import { redirect } from "next/navigation";

import { WorkspaceSettings } from "@/components/workspace-settings";
import { getOwnerSafe } from "@/lib/auth/owner";
import { currentTeam, listTeamInvites, listTeamMembers } from "@/lib/db/teams";
import { managesTeam } from "@/lib/teams/roles";

export const dynamic = "force-dynamic";

/** The workspace open in the app: its name, people and invites. */
export default async function WorkspaceSettingsPage() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/workspace");

  const team = await currentTeam(owner.id);
  if (!team) redirect("/");

  const [members, invites] = await Promise.all([
    listTeamMembers(team.id),
    managesTeam(team.role) && !team.personal ? listTeamInvites(team.id) : Promise.resolve([]),
  ]);
  return <WorkspaceSettings team={team} members={members} invites={invites} meId={owner.id} />;
}
