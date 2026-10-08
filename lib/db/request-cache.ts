import { cache } from "react";

import { getProject, listProjects, listWorkspaces } from "@/lib/db/repositories";

/**
 * Reads shared by the app layout's sidebar and the page under it, deduplicated
 * per request (React `cache`): the home page and the sidebar both need every
 * workspace, and should not query for them twice. Errors still throw; each
 * caller decides whether a failed load may take its view down.
 */
export const listProjectsOnce = cache(() => listProjects());
export const listWorkspacesOnce = cache(() => listWorkspaces());
export const getProjectOnce = cache((id: string) => getProject(id));
