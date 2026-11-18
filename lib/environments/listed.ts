/**
 * Environments as people pick them: the Environments page and the
 * new-session picker list these (listed_environments,
 * 20261119120000_environments_model.sql). Pure, so the browser shares it.
 *
 * Which are listed is the database's rule (environment_listed): every one
 * someone made, and a repository's own environment (made on its first
 * session, for the API's by-repository calls and automations) only once
 * someone has made it their own — renamed it, or given it a description,
 * instructions, variables, files, a script or hook, another repository,
 * skills, MCP servers or a secret sync. A repository's untouched own
 * environment stays out of the list; picking the repository itself starts
 * from it, as before.
 */

/** A listed environment: enough to show it and start a session from it. */
export type ListedEnvironment = {
  id: string;
  name: string;
  /** The repository this is the own environment of; null for one made. */
  defaultForProjectId: string | null;
  /** The org's default: the new-session screen starts on it. */
  orgDefault: boolean;
  /** Its repositories, in their order. */
  repos: { projectId: string; fullName: string }[];
};

/**
 * The repository a session of the environment works in first (the one its
 * branch is named in and its pull request opened from, the others checked
 * out beside it): the repository it's the own environment of, else its
 * first. Null for one with no repository left. The API and the
 * new-session screen both start an environment's session here.
 */
export function workRepoId(environment: Pick<ListedEnvironment, "defaultForProjectId" | "repos">): string | null {
  return environment.defaultForProjectId ?? environment.repos[0]?.projectId ?? null;
}

/** One row of listed_environments, as the database sends it. */
export type ListedEnvironmentRow = {
  id: string;
  name: string;
  default_for_project_id: string | null;
  org_default: boolean | null;
  repos: unknown;
};

/** The rows as environments; a repository entry that isn't one is dropped
 *  rather than failing the list. */
export function listedFromRows(rows: readonly ListedEnvironmentRow[]): ListedEnvironment[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    defaultForProjectId: row.default_for_project_id,
    orgDefault: row.org_default === true,
    repos: (Array.isArray(row.repos) ? row.repos : []).flatMap((repo: unknown) => {
      if (!repo || typeof repo !== "object") return [];
      const { projectId, fullName } = repo as Record<string, unknown>;
      return typeof projectId === "string" && typeof fullName === "string" ? [{ projectId, fullName }] : [];
    }),
  }));
}
