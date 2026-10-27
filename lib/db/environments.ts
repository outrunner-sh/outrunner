/**
 * Projects, as the app calls them: an `environments` row
 * (20261027121000_environments.sql) and its repositories. Not the `projects`
 * table, which holds one connected GitHub repository a row and is where an
 * environment's repositories come from.
 *
 * Each repository has a default environment holding just it, made on first
 * use here (defaultEnvironmentId), so a session started in a repository
 * starts from its project.
 *
 * The variables and files are sealed together, {env, files}
 * (lib/crypto/secret-box.ts), their names and paths kept beside them for
 * showing without opening them. Service role only — the tables have no
 * policy.
 *
 * A project is its org's (20261028140000_org_environments.sql), as its
 * repositories are. Each function here takes the user asking, and does only
 * what their access lets them (20261028150000_org_access.sql): reading needs
 * read on every one of the project's repositories, and changing it, write
 * (environment_level). Refused, a read finds nothing and a change throws
 * EnvironmentAccessError.
 */

import { open, seal } from "@/lib/crypto/secret-box";
import type { ProjectEnvironment, ProjectScripts } from "@/lib/db/project-environment";
import { environmentLevel, projectLevel } from "@/lib/db/org-access";
import { applySecretsEdit, checkoutNameFor, type EnvironmentSecrets, type SecretsEdit } from "@/lib/environments/rules";
import { type AccessLevel, allows } from "@/lib/orgs/access";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** The user may read the project but not change it. */
export class EnvironmentAccessError extends Error {
  constructor() {
    super("You can see this project but not change it. Ask an admin of its org for write access.");
    this.name = "EnvironmentAccessError";
  }
}

/** Throw unless `userId` may change the project. */
async function requireWrite(userId: string, id: string): Promise<void> {
  if (!allows(await environmentLevel(userId, id), "write")) throw new EnvironmentAccessError();
}

export type EnvironmentRepo = {
  projectId: string;
  /** `owner/name`. */
  fullName: string;
  /** The folder it is cloned into. */
  checkoutName: string;
  /** The branch sessions start from; null is the repository's default. */
  branch: string | null;
  defaultBranch: string;
};

/** A project as its settings page shows it: everything but the secrets'
 *  values. */
export type Environment = {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  repos: EnvironmentRepo[];
  envNames: string[];
  filePaths: string[];
  scripts: ProjectScripts;
  /** The repository this is the default project of; null for one the user
   *  made. */
  defaultForProjectId: string | null;
  updatedAt: string;
  /** What the user asking may do with it: write, or only read. */
  access: AccessLevel;
};

/** What a session starts with: the secrets opened, the scripts, and the
 *  instructions for its agent. */
export type EnvironmentSetup = ProjectEnvironment & { instructions: string | null };

export type EnvironmentPatch = {
  name?: string;
  description?: string | null;
  instructions?: string | null;
  scripts?: Partial<ProjectScripts>;
};

/** The project, or null when there's none by that id the user may read. */
export async function getEnvironment(userId: string, id: string): Promise<Environment | null> {
  const access = await environmentLevel(userId, id);
  if (!access) return null;
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("environments")
    .select(
      "id, org_id, name, description, instructions, env_names, file_paths, setup_script, run_script, archive_script, default_for_project_id, updated_at",
    )
    .eq("id", id)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    name: data.name,
    description: data.description,
    instructions: data.instructions,
    repos: await environmentRepos(data.org_id, id),
    envNames: data.env_names,
    filePaths: data.file_paths,
    scripts: { setup: data.setup_script, run: data.run_script, archive: data.archive_script },
    defaultForProjectId: data.default_for_project_id,
    updatedAt: data.updated_at,
    access,
  };
}

async function environmentRepos(orgId: string, environmentId: string): Promise<EnvironmentRepo[]> {
  const supabase = createSupabaseAdminClient();
  const { data: rows, error } = await supabase
    .from("environment_repos")
    .select("project_id, checkout_name, branch, position")
    .eq("org_id", orgId)
    .eq("environment_id", environmentId)
    .order("position", { ascending: true });
  if (error) throw error;
  if (rows.length === 0) return [];
  const { data: projects, error: projectsError } = await supabase
    .from("projects")
    .select("id, full_name, default_branch")
    .eq("org_id", orgId)
    .in(
      "id",
      rows.map((r) => r.project_id),
    );
  if (projectsError) throw projectsError;
  const byId = new Map(projects.map((p) => [p.id, p]));
  return rows.flatMap((r) => {
    const project = byId.get(r.project_id);
    if (!project) return [];
    return [
      {
        projectId: r.project_id,
        fullName: project.full_name,
        checkoutName: r.checkout_name,
        branch: r.branch,
        defaultBranch: project.default_branch,
      },
    ];
  });
}

/** The id of the repository's default project, or null when it has none
 *  yet, or the user can't read the repository. Makes nothing. */
export async function findDefaultEnvironmentId(userId: string, projectId: string): Promise<string | null> {
  if (!(await projectLevel(userId, projectId))) return null;
  const { data, error } = await createSupabaseAdminClient()
    .from("environments")
    .select("id")
    .eq("default_for_project_id", projectId)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/**
 * The id of the repository's default project, made now if it has none: one
 * per repository, in its org, whichever member's session needs it first,
 * made with its repository at once (make_default_environment). Null when the
 * user can't read the repository.
 */
export async function defaultEnvironmentId(userId: string, projectId: string): Promise<string | null> {
  if (!(await projectLevel(userId, projectId))) return null;
  const supabase = createSupabaseAdminClient();
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("name")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError) throw projectError;
  if (!project) return null;
  const { data, error } = await supabase.rpc("make_default_environment", {
    target_project: projectId,
    maker: userId,
    checkout: checkoutNameFor(project.name),
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

/** What a session started from the project gets; null when there is no such
 *  project. A sealed value that no longer opens reads as no variables rather
 *  than failing the session. */
export async function environmentSetup(userId: string, id: string): Promise<EnvironmentSetup | null> {
  if (!(await environmentLevel(userId, id))) return null;
  const { data, error } = await createSupabaseAdminClient()
    .from("environments")
    .select("secrets_ciphertext, setup_script, run_script, archive_script, instructions")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    ...openSecrets(id, data.secrets_ciphertext),
    setup: data.setup_script,
    run: data.run_script,
    archive: data.archive_script,
    instructions: data.instructions,
  };
}

function openSecrets(id: string, ciphertext: string | null): EnvironmentSecrets {
  if (!ciphertext) return { env: {}, files: {} };
  try {
    const secrets = JSON.parse(open(ciphertext)) as Partial<EnvironmentSecrets>;
    return { env: secrets.env ?? {}, files: secrets.files ?? {} };
  } catch (cause) {
    console.error(`Project ${id}'s secrets can't be opened`, cause);
    return { env: {}, files: {} };
  }
}

/** Whether the project keeps anything a session starts with: variables,
 *  files or a script. Reads no secrets. */
export async function environmentHasSetup(userId: string, id: string): Promise<boolean> {
  if (!(await environmentLevel(userId, id))) return false;
  const { data, error } = await createSupabaseAdminClient()
    .from("environments")
    .select("env_names, file_paths, setup_script, run_script, archive_script")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  return (
    data.env_names.length + data.file_paths.length > 0 ||
    Boolean(data.setup_script || data.run_script || data.archive_script)
  );
}

/** Change the project's name, description, instructions or scripts. A field
 *  left out is left as it is. Needs write (else EnvironmentAccessError). */
export async function updateEnvironment(userId: string, id: string, patch: EnvironmentPatch): Promise<void> {
  await requireWrite(userId, id);
  const { error } = await createSupabaseAdminClient()
    .from("environments")
    .update({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.instructions !== undefined && { instructions: patch.instructions }),
      ...(patch.scripts?.setup !== undefined && { setup_script: patch.scripts.setup }),
      ...(patch.scripts?.run !== undefined && { run_script: patch.scripts.run }),
      ...(patch.scripts?.archive !== undefined && { archive_script: patch.scripts.archive }),
    })
    .eq("id", id);
  if (error) throw error;
}

/** Another save kept changing the project's secrets while this one tried
 *  to; nothing of this one was saved. */
export class EnvironmentConflictError extends Error {
  constructor() {
    super("The project changed while saving. Try again.");
  }
}

/** How many times an edit is tried again after losing a race with another. */
const EDIT_TRIES = 3;

/** Set and remove the project's variables and files (rules.applySecretsEdit
 *  refuses what a session can't take), resealed whole. The names and paths
 *  it keeps after.
 *
 *  The secrets are one sealed value, read, changed and written back, so two
 *  edits at once (two tabs, the Mac import beside the settings page) would
 *  each write what they read and the later one drop the earlier's. The write
 *  only lands if the row is as it was read (its updated_at, which every
 *  write moves); otherwise the edit is made again on what is there now.
 *  Needs write (else EnvironmentAccessError), asked once for every try. */
export async function editEnvironmentSecrets(
  userId: string,
  id: string,
  edit: SecretsEdit,
): Promise<{ envNames: string[]; filePaths: string[] }> {
  await requireWrite(userId, id);
  const supabase = createSupabaseAdminClient();
  for (let attempt = 0; attempt < EDIT_TRIES; attempt++) {
    const { data, error } = await supabase
      .from("environments")
      .select("secrets_ciphertext, updated_at")
      .eq("id", id)
      .single();
    if (error) throw error;
    const next = applySecretsEdit(openSecrets(id, data.secrets_ciphertext), edit);
    const envNames = Object.keys(next.env).sort();
    const filePaths = Object.keys(next.files).sort();
    const { data: written, error: updateError } = await supabase
      .from("environments")
      .update({
        secrets_ciphertext: envNames.length + filePaths.length > 0 ? seal(JSON.stringify(next)) : null,
        env_names: envNames,
        file_paths: filePaths,
      })
      .eq("id", id)
      .eq("updated_at", data.updated_at)
      .select("id");
    if (updateError) throw updateError;
    if (written.length > 0) return { envNames, filePaths };
  }
  throw new EnvironmentConflictError();
}

/** Keep what the user picked of a repository's environment on their Mac in
 *  the repository's default project: a variable of the same name, a file at
 *  the same path, or a script given, replaces the one there. False, keeping
 *  nothing, for a repository the user can't read; EnvironmentAccessError for
 *  one they can read but not change. */
export async function mergeIntoDefaultEnvironment(
  userId: string,
  projectId: string,
  add: { env: Record<string, string>; files: Record<string, string>; scripts: Partial<ProjectScripts> },
): Promise<boolean> {
  const id = await defaultEnvironmentId(userId, projectId);
  if (!id) return false;
  await editEnvironmentSecrets(userId, id, { setEnv: add.env, setFiles: add.files });
  if (Object.keys(add.scripts).length > 0) await updateEnvironment(userId, id, { scripts: add.scripts });
  return true;
}
