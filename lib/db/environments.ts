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
 * policy — and always scoped to the owner here.
 */

import { open, seal } from "@/lib/crypto/secret-box";
import { mergeProjectEnvironment, type ProjectEnvironment, type ProjectScripts } from "@/lib/db/project-environment";
import { applySecretsEdit, checkoutNameFor, type EnvironmentSecrets, type SecretsEdit } from "@/lib/environments/rules";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

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

/** The project, or null when the owner has none by that id (or before the
 *  migration that adds them). */
export async function getEnvironment(ownerId: string, id: string): Promise<Environment | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("environments")
    .select(
      "id, name, description, instructions, env_names, file_paths, setup_script, run_script, archive_script, default_for_project_id, updated_at",
    )
    .eq("owner_id", ownerId)
    .eq("id", id)
    .is("archived_at", null)
    .maybeSingle();
  if (error && probeStatus(error) === "missing") return null;
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    name: data.name,
    description: data.description,
    instructions: data.instructions,
    repos: await environmentRepos(ownerId, id),
    envNames: data.env_names,
    filePaths: data.file_paths,
    scripts: { setup: data.setup_script, run: data.run_script, archive: data.archive_script },
    defaultForProjectId: data.default_for_project_id,
    updatedAt: data.updated_at,
  };
}

async function environmentRepos(ownerId: string, environmentId: string): Promise<EnvironmentRepo[]> {
  const supabase = createSupabaseAdminClient();
  const { data: rows, error } = await supabase
    .from("environment_repos")
    .select("project_id, checkout_name, branch, position")
    .eq("owner_id", ownerId)
    .eq("environment_id", environmentId)
    .order("position", { ascending: true });
  if (error) throw error;
  if (rows.length === 0) return [];
  const { data: projects, error: projectsError } = await supabase
    .from("projects")
    .select("id, full_name, default_branch")
    .eq("owner_id", ownerId)
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
 *  yet (or before the migration that adds projects). Makes nothing. */
export async function findDefaultEnvironmentId(ownerId: string, projectId: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("environments")
    .select("id")
    .eq("owner_id", ownerId)
    .eq("default_for_project_id", projectId)
    .maybeSingle();
  if (error && probeStatus(error) === "missing") return null;
  if (error) throw error;
  return data?.id ?? null;
}

/**
 * The id of the repository's default project, made now if it has none; null
 * when the owner has no such repository, or before the migration that adds
 * projects (a session then starts from project_environment, as before).
 */
export async function defaultEnvironmentId(ownerId: string, projectId: string): Promise<string | null> {
  const supabase = createSupabaseAdminClient();
  const found = await supabase
    .from("environments")
    .select("id")
    .eq("owner_id", ownerId)
    .eq("default_for_project_id", projectId)
    .maybeSingle();
  if (found.error && probeStatus(found.error) === "missing") return null;
  if (found.error) throw found.error;
  if (found.data) return found.data.id;

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, name")
    .eq("owner_id", ownerId)
    .eq("id", projectId)
    .maybeSingle();
  if (projectError) throw projectError;
  if (!project) return null;

  const made = await supabase
    .from("environments")
    .insert({ owner_id: ownerId, name: project.name.slice(0, 80), default_for_project_id: projectId })
    .select("id")
    .single();
  if (made.error) {
    // Made at the same moment by another request (two sessions started at
    // once): theirs is the one.
    if (made.error.code === "23505") return defaultEnvironmentId(ownerId, projectId);
    throw made.error;
  }
  const { error: repoError } = await supabase.from("environment_repos").insert({
    owner_id: ownerId,
    environment_id: made.data.id,
    project_id: projectId,
    checkout_name: checkoutNameFor(project.name),
  });
  if (repoError) {
    // A project with no repository is no default project: take it back, so
    // the next call makes it again.
    await supabase.from("environments").delete().eq("owner_id", ownerId).eq("id", made.data.id);
    throw repoError;
  }
  return made.data.id;
}

/** What a session started from the project gets; null when there is no such
 *  project. A sealed value that no longer opens reads as no variables rather
 *  than failing the session. */
export async function environmentSetup(ownerId: string, id: string): Promise<EnvironmentSetup | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("environments")
    .select("secrets_ciphertext, setup_script, run_script, archive_script, instructions")
    .eq("owner_id", ownerId)
    .eq("id", id)
    .maybeSingle();
  if (error && probeStatus(error) === "missing") return null;
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
export async function environmentHasSetup(ownerId: string, id: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("environments")
    .select("env_names, file_paths, setup_script, run_script, archive_script")
    .eq("owner_id", ownerId)
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
 *  left out is left as it is. */
export async function updateEnvironment(ownerId: string, id: string, patch: EnvironmentPatch): Promise<void> {
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
    .eq("owner_id", ownerId)
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
 *  write moves); otherwise the edit is made again on what is there now. */
export async function editEnvironmentSecrets(
  ownerId: string,
  id: string,
  edit: SecretsEdit,
): Promise<{ envNames: string[]; filePaths: string[] }> {
  const supabase = createSupabaseAdminClient();
  for (let attempt = 0; attempt < EDIT_TRIES; attempt++) {
    const { data, error } = await supabase
      .from("environments")
      .select("secrets_ciphertext, updated_at")
      .eq("owner_id", ownerId)
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
      .eq("owner_id", ownerId)
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
 *  the same path, or a script given, replaces the one there. Before the
 *  migration that adds projects, in project_environment as before. */
export async function mergeIntoDefaultEnvironment(
  ownerId: string,
  projectId: string,
  add: { env: Record<string, string>; files: Record<string, string>; scripts: Partial<ProjectScripts> },
): Promise<void> {
  const id = await defaultEnvironmentId(ownerId, projectId);
  if (!id) return mergeProjectEnvironment(ownerId, projectId, add);
  await editEnvironmentSecrets(ownerId, id, { setEnv: add.env, setFiles: add.files });
  if (Object.keys(add.scripts).length > 0) await updateEnvironment(ownerId, id, { scripts: add.scripts });
}
