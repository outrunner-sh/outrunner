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
 * repositories are, so every member of the org reads and changes it and
 * starts sessions from it. Each function here takes the user asking, and
 * reaches only projects of the orgs they're a member of.
 */

import { open, seal } from "@/lib/crypto/secret-box";
import type { ProjectEnvironment, ProjectScripts } from "@/lib/db/project-environment";
import {
  applySecretsEdit,
  checkoutNameFor,
  EnvironmentRuleError,
  type EnvironmentSecrets,
  MAX_REPOS,
  type SecretsEdit,
} from "@/lib/environments/rules";
import type { SessionCheckout } from "@/lib/runtime/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** The orgs `userId` is a member of: the projects they may reach are theirs.
 *  Every function here asks once, and takes it given (`orgs`) when its caller
 *  asked already, as an import's steps do. Needs 20261028140000. */
async function memberOrgIds(userId: string): Promise<string[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("organization_members")
    .select("org_id")
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []).map((m) => m.org_id);
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
  /** Its place in the project's list (and in a session's folder). */
  position: number;
  private: boolean;
};

/** A project as its settings page shows it: everything but the secrets'
 *  values. */
export type Environment = {
  id: string;
  /** The org it's in: its repositories are that org's. */
  orgId: string;
  name: string;
  description: string | null;
  instructions: string | null;
  repos: EnvironmentRepo[];
  envNames: string[];
  filePaths: string[];
  scripts: ProjectScripts;
  hooks: ProjectHooks;
  /** The repository this is the default project of; null for one the user
   *  made. */
  defaultForProjectId: string | null;
  /** Counts the changes ready boxes are made from (warm-pool.ts). */
  setupGeneration: number;
  /** The warm hook's last run on a ready box, or null for none yet. */
  warm: WarmRun | null;
  updatedAt: string;
};

/** The warm hook, run ahead on a ready box, and the start hook, run at each
 *  launch of a session's agent. */
export type ProjectHooks = { warm: string | null; start: string | null };

/** A warm hook's run on a ready box, for the settings page. */
export type WarmRun = {
  status: "running" | "succeeded" | "failed";
  /** The end of its output. */
  log: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The setup generation it ran for. */
  generation: number | null;
};

/** What a session starts with: the secrets opened, the scripts, and the
 *  instructions for its agent. */
export type EnvironmentSetup = ProjectEnvironment & {
  instructions: string | null;
  hooks?: ProjectHooks;
  /** The setup's generation, which a ready box must be made from to be
   *  taken. */
  generation?: number;
};

export type EnvironmentPatch = {
  name?: string;
  description?: string | null;
  instructions?: string | null;
  scripts?: Partial<ProjectScripts>;
  hooks?: Partial<ProjectHooks>;
};

/** The project, or null when none by that id is in the user's orgs. */
export async function getEnvironment(userId: string, id: string): Promise<Environment | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("environments")
    .select(
      "id, org_id, name, description, instructions, env_names, file_paths, setup_script, run_script, archive_script, default_for_project_id, updated_at, warm_hook, start_hook, setup_generation, warm_status, warm_log, warm_started_at, warm_finished_at, warm_generation",
    )
    .in("org_id", await memberOrgIds(userId))
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
    orgId: data.org_id,
    repos: await environmentRepos(data.org_id, id),
    envNames: data.env_names,
    filePaths: data.file_paths,
    scripts: { setup: data.setup_script, run: data.run_script, archive: data.archive_script },
    hooks: { warm: data.warm_hook, start: data.start_hook },
    defaultForProjectId: data.default_for_project_id,
    setupGeneration: data.setup_generation,
    warm: data.warm_status
      ? {
          status: data.warm_status,
          log: data.warm_log,
          startedAt: data.warm_started_at,
          finishedAt: data.warm_finished_at,
          generation: data.warm_generation,
        }
      : null,
    updatedAt: data.updated_at,
  };
}

async function environmentRepos(orgId: string, environmentId: string): Promise<EnvironmentRepo[]> {
  const supabase = createSupabaseAdminClient();
  const { data: rows, error } = await supabase
    .from("environment_repos")
    .select("project_id, checkout_name, branch, position, created_at")
    .eq("org_id", orgId)
    .eq("environment_id", environmentId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  if (rows.length === 0) return [];
  const { data: projects, error: projectsError } = await supabase
    .from("projects")
    .select("id, full_name, default_branch, is_private")
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
        position: r.position,
        private: project.is_private,
      },
    ];
  });
}

/** The id of the repository's default project, or null when it has none
 *  yet. Makes nothing. */
export async function findDefaultEnvironmentId(userId: string, projectId: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("environments")
    .select("id")
    .in("org_id", await memberOrgIds(userId))
    .eq("default_for_project_id", projectId)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/**
 * The id of the repository's default project, made now if it has none: one
 * per repository, in its org, whichever member's session needs it first.
 * Null when the repository isn't in one of the user's orgs.
 */
export async function defaultEnvironmentId(
  userId: string,
  projectId: string,
  orgs?: string[],
): Promise<string | null> {
  const supabase = createSupabaseAdminClient();
  orgs ??= await memberOrgIds(userId);
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, name, org_id")
    .in("org_id", orgs)
    .eq("id", projectId)
    .maybeSingle();
  if (projectError) throw projectError;
  if (!project) return null;

  const found = await supabase
    .from("environments")
    .select("id")
    .eq("org_id", project.org_id)
    .eq("default_for_project_id", projectId)
    .maybeSingle();
  if (found.error) throw found.error;
  if (found.data) return found.data.id;

  const made = await supabase
    .from("environments")
    .insert({
      org_id: project.org_id,
      owner_id: userId,
      name: project.name.slice(0, 80),
      default_for_project_id: projectId,
    })
    .select("id")
    .single();
  if (made.error) {
    // Made at the same moment by another request (two sessions started at
    // once, maybe two members'): theirs is the one.
    if (made.error.code === "23505") return defaultEnvironmentId(userId, projectId, orgs);
    throw made.error;
  }
  const { error: repoError } = await supabase.from("environment_repos").insert({
    owner_id: userId,
    environment_id: made.data.id,
    project_id: projectId,
    checkout_name: checkoutNameFor(project.name),
  });
  if (repoError) {
    // A project with no repository is no default project: take it back, so
    // the next call makes it again.
    await supabase.from("environments").delete().eq("id", made.data.id);
    throw repoError;
  }
  return made.data.id;
}

/** What a session started from the project gets; null when there is no such
 *  project. A sealed value that no longer opens reads as no variables rather
 *  than failing the session. */
export async function environmentSetup(userId: string, id: string): Promise<EnvironmentSetup | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("environments")
    .select("secrets_ciphertext, setup_script, run_script, archive_script, instructions, warm_hook, start_hook, setup_generation")
    .in("org_id", await memberOrgIds(userId))
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
    hooks: { warm: data.warm_hook, start: data.start_hook },
    generation: data.setup_generation,
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
  const { data, error } = await createSupabaseAdminClient()
    .from("environments")
    .select("env_names, file_paths, setup_script, run_script, archive_script, warm_hook, start_hook")
    .in("org_id", await memberOrgIds(userId))
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  return (
    data.env_names.length + data.file_paths.length > 0 ||
    Boolean(data.setup_script || data.run_script || data.archive_script || data.warm_hook || data.start_hook)
  );
}

/** Change the project's name, description, instructions, scripts or hooks.
 *  A field left out is left as it is. A new warm hook moves the project's
 *  setup on a generation, so its ready boxes are made again. */
export async function updateEnvironment(
  userId: string,
  id: string,
  patch: EnvironmentPatch,
  orgs?: string[],
): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("environments")
    .update({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.instructions !== undefined && { instructions: patch.instructions }),
      ...(patch.scripts?.setup !== undefined && { setup_script: patch.scripts.setup }),
      ...(patch.scripts?.run !== undefined && { run_script: patch.scripts.run }),
      ...(patch.scripts?.archive !== undefined && { archive_script: patch.scripts.archive }),
      ...(patch.hooks?.warm !== undefined && { warm_hook: patch.hooks.warm }),
      ...(patch.hooks?.start !== undefined && { start_hook: patch.hooks.start }),
    })
    .in("org_id", orgs ?? (await memberOrgIds(userId)))
    .eq("id", id);
  if (error) throw error;
  if (patch.hooks?.warm !== undefined) await bumpGeneration(userId, id, orgs);
}

/** Move the project's setup on a generation: its ready boxes are made again
 *  (a change they're made from, or "Try again"). The new one. */
export async function bumpGeneration(userId: string, id: string, orgs?: string[]): Promise<number | null> {
  const supabase = createSupabaseAdminClient();
  // In one of the user's orgs, checked first: the function takes any id.
  const { data: own, error: ownError } = await supabase
    .from("environments")
    .select("id")
    .in("org_id", orgs ?? (await memberOrgIds(userId)))
    .eq("id", id)
    .maybeSingle();
  if (ownError) throw ownError;
  if (!own) return null;
  const { data, error } = await supabase.rpc("bump_environment_generation", { target: id });
  // Before the migration that adds it: nothing to make again.
  if (error && (error.code === "PGRST202" || error.code === "42883")) return null;
  if (error) throw error;
  return typeof data === "number" ? data : null;
}

/** Record the warm hook's run on a ready box, for the settings page. A
 *  project's two boxes warm at once: a failure of a generation stays shown
 *  until a new generation (an edit, "Try again"), whatever the other box's
 *  run says after. */
export async function recordWarmRun(id: string, run: WarmRun): Promise<void> {
  let query = createSupabaseAdminClient()
    .from("environments")
    .update({
      warm_status: run.status,
      warm_log: run.log,
      warm_started_at: run.startedAt,
      warm_finished_at: run.finishedAt,
      warm_generation: run.generation,
    })
    .eq("id", id);
  if (run.status !== "failed" && run.generation !== null) {
    query = query.or(`warm_status.is.null,warm_status.neq.failed,warm_generation.is.null,warm_generation.neq.${run.generation}`);
  }
  const { error } = await query;
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
  userId: string,
  id: string,
  edit: SecretsEdit,
  orgs?: string[],
): Promise<{ envNames: string[]; filePaths: string[] }> {
  const supabase = createSupabaseAdminClient();
  // Once, for every try: the read and its write reach the same orgs.
  const reach = orgs ?? (await memberOrgIds(userId));
  for (let attempt = 0; attempt < EDIT_TRIES; attempt++) {
    const { data, error } = await supabase
      .from("environments")
      .select("secrets_ciphertext, updated_at")
      .in("org_id", reach)
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
      .in("org_id", reach)
      .eq("id", id)
      .eq("updated_at", data.updated_at)
      .select("id");
    if (updateError) throw updateError;
    if (written.length > 0) {
      // Ready boxes carry the variables and files they were warmed with.
      await bumpGeneration(userId, id, reach);
      return { envNames, filePaths };
    }
  }
  throw new EnvironmentConflictError();
}

/** Keep what the user picked of a repository's environment on their Mac in
 *  the repository's default project: a variable of the same name, a file at
 *  the same path, or a script given, replaces the one there. False, keeping
 *  nothing, for a repository that isn't in one of the user's orgs. */
export async function mergeIntoDefaultEnvironment(
  ownerId: string,
  projectId: string,
  add: { env: Record<string, string>; files: Record<string, string>; scripts: Partial<ProjectScripts> },
): Promise<boolean> {
  const orgs = await memberOrgIds(ownerId);
  const id = await defaultEnvironmentId(ownerId, projectId, orgs);
  if (!id) return false;
  await editEnvironmentSecrets(ownerId, id, { setEnv: add.env, setFiles: add.files }, orgs);
  if (Object.keys(add.scripts).length > 0) await updateEnvironment(ownerId, id, { scripts: add.scripts }, orgs);
  return true;
}

/** The generation of the project's setup a ready box must be made from to be
 *  taken; null for no project (any box, then). */
export async function setupGeneration(userId: string, id: string | null): Promise<number | null> {
  if (!id) return null;
  const { data, error } = await createSupabaseAdminClient()
    .from("environments")
    .select("setup_generation")
    .in("org_id", await memberOrgIds(userId))
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data?.setup_generation ?? null;
}

/** The repositories a new session of the project works on, when it has
 *  several (each in its own folder, from its branch); null for a project of
 *  one, whose session is as every session was. */
export async function sessionCheckouts(userId: string, id: string): Promise<SessionCheckout[] | null> {
  const environment = await getEnvironment(userId, id);
  if (!environment || environment.repos.length < 2) return null;
  return environment.repos.map((r) => ({
    projectId: r.projectId,
    fullName: r.fullName,
    checkout: r.checkoutName,
    baseBranch: r.branch ?? r.defaultBranch,
    private: r.private,
  }));
}

/** Add a repository of the project's org to it, in a folder named after it
 *  (made unique), last. Refused past MAX_REPOS, or for a repository of
 *  another org. */
export async function addEnvironmentRepo(userId: string, id: string, projectId: string): Promise<void> {
  const environment = await getEnvironment(userId, id);
  if (!environment) throw new EnvironmentRuleError("Project not found.");
  if (environment.repos.some((r) => r.projectId === projectId)) return;
  if (environment.repos.length >= MAX_REPOS) {
    throw new EnvironmentRuleError(`A project holds at most ${MAX_REPOS} repositories.`);
  }
  const supabase = createSupabaseAdminClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, name")
    .eq("org_id", environment.orgId)
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw error;
  if (!project) throw new EnvironmentRuleError("That repository isn't connected to this project's organization.");
  const taken = new Set(environment.repos.map((r) => r.checkoutName));
  const base = checkoutNameFor(project.name);
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 96)}-${n}`;
  const { error: insertError } = await supabase.from("environment_repos").insert({
    owner_id: userId,
    environment_id: id,
    project_id: projectId,
    checkout_name: name,
    // After the last, whatever was removed between: no two share a place.
    position: Math.max(-1, ...environment.repos.map((r) => r.position)) + 1,
  });
  if (insertError?.message.includes("at most 5")) {
    throw new EnvironmentRuleError(`A project holds at most ${MAX_REPOS} repositories.`);
  }
  // Another add at the same moment took the folder name, or the repository.
  if (insertError?.code === "23505") {
    throw new EnvironmentRuleError("The project changed while adding that repository. Try again.");
  }
  if (insertError) throw insertError;
}

/** Remove a repository from the project; never its last, nor the one a
 *  repository's default project is for (it would no longer be that one's). */
export async function removeEnvironmentRepo(userId: string, id: string, projectId: string): Promise<void> {
  const environment = await getEnvironment(userId, id);
  if (!environment) throw new EnvironmentRuleError("Project not found.");
  if (environment.repos.length <= 1) throw new EnvironmentRuleError("A project keeps at least one repository.");
  if (environment.defaultForProjectId === projectId) {
    throw new EnvironmentRuleError("This project is that repository's own: remove the others instead.");
  }
  const { error } = await createSupabaseAdminClient()
    .from("environment_repos")
    .delete()
    .eq("org_id", environment.orgId)
    .eq("environment_id", id)
    .eq("project_id", projectId);
  if (error) throw error;
}
