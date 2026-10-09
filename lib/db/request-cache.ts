import { cache } from "react";

import { getOwnerSafe } from "@/lib/auth/owner";
import { getProject, listProjects, listTeamProjectIds, listWorkspaces } from "@/lib/db/repositories";
import { currentTeam, listTeamMembers } from "@/lib/db/teams";

/**
 * Reads shared by the app layout's sidebar and the page under it, deduplicated
 * per request (React `cache`): the home page and the sidebar both need every
 * workspace, and should not query for them twice. Errors still throw; each
 * caller decides whether a failed load may take its view down.
 *
 * Projects and sessions are the workspace's open in the app (see
 * {@link currentTeamOnce}): RLS would show those of every team the user is in.
 */
export const currentTeamOnce = cache(async () => {
  const owner = await getOwnerSafe();
  return owner ? currentTeam(owner.id) : null;
});

export const listProjectsOnce = cache(async () => {
  const team = await currentTeamOnce();
  return team ? listProjects(team.id) : [];
});

export const listWorkspacesOnce = cache(async () => {
  const team = await currentTeamOnce();
  return team ? listWorkspaces({ projectIds: await listTeamProjectIds(team.id) }) : [];
});

export const listTeamMembersOnce = cache(async () => {
  const team = await currentTeamOnce();
  return team ? listTeamMembers(team.id) : [];
});

export const getProjectOnce = cache((id: string) => getProject(id));
