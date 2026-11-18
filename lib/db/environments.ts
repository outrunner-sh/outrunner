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
 * what their access lets them (20261028145000_org_access.sql): reading needs
 * read on every one of the project's repositories, and changing it, write
 * (environment_level). Refused, a read finds nothing and a change throws
 * EnvironmentAccessError.
 */

import { open, seal } from "@/lib/crypto/secret-box";
import type { ProjectEnvironment, ProjectScripts } from "@/lib/db/project-environment";
import { environmentLevel, projectLevel } from "@/lib/db/org-access";
import {
  applySecretsEdit,
  checkoutNameFor,
  EnvironmentRuleError,
  type EnvironmentSecrets,
  MAX_REPOS,
  type SecretsEdit,
} from "@/lib/environments/rules";
import { type AccessLevel, allows } from "@/lib/orgs/access";
import type { SessionCheckout } from "@/lib/runtime/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** The user may read the project but not change it. */
export class EnvironmentAccessError extends Error {
  constructor() {
    super("You can see this environment but not change it. Ask an admin of its org for write access.");
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
  /** The warm hook's last run on the asker's ready boxes (each member has
   *  their own pool), or null for none yet. */
  warm: WarmRun | null;
  updatedAt: string;
  /** When it was made; absent on one made in code rather than read. */
  createdAt?: string;
  /** What the user asking may do with it: write, or only read. */
  access: AccessLevel;
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

/** The project, or null when there's none by that id the user may read. */
export async function getEnvironment(userId: string, id: string): Promise<Environment | null> {
  const access = await environmentLevel(userId, id);
  if (!access) return null;
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("environments")
    .select(
      "id, org_id, name, description, instructions, env_names, file_paths, setup_script, run_script, archive_script, default_for_project_id, updated_at, created_at, warm_hook, start_hook, setup_generation, warm_runs",
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
    orgId: data.org_id,
    repos: await environmentRepos(data.org_id, id),
    envNames: data.env_names,
    filePaths: data.file_paths,
    scripts: { setup: data.setup_script, run: data.run_script, archive: data.archive_script },
    hooks: { warm: data.warm_hook, start: data.start_hook },
    defaultForProjectId: data.default_for_project_id,
    setupGeneration: data.setup_generation,
    warm: warmRunOf(data.warm_runs, userId),
    updatedAt: data.updated_at,
    createdAt: data.created_at,
    access,
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

/** The org of a project the user can see (not archived), or null: what
 *  getEnvironment answers for orgId, without the rest. */
export async function environmentOrgId(userId: string, id: string): Promise<string | null> {
  const [level, { data, error }] = await Promise.all([
    environmentLevel(userId, id),
    createSupabaseAdminClient().from("environments").select("org_id").eq("id", id).is("archived_at", null).maybeSingle(),
  ]);
  if (error) throw error;
  return level ? (data?.org_id ?? null) : null;
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
    .select("secrets_ciphertext, setup_script, run_script, archive_script, instructions, warm_hook, start_hook, setup_generation")
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
  if (!(await environmentLevel(userId, id))) return false;
  const { data, error } = await createSupabaseAdminClient()
    .from("environments")
    .select("env_names, file_paths, setup_script, run_script, archive_script, warm_hook, start_hook")
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
 *  setup on a generation, so its ready boxes are made again. Needs write
 *  (else EnvironmentAccessError). */
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
      ...(patch.hooks?.warm !== undefined && { warm_hook: patch.hooks.warm }),
      ...(patch.hooks?.start !== undefined && { start_hook: patch.hooks.start }),
    })
    .eq("id", id);
  if (error) throw error;
  if (patch.hooks?.warm !== undefined) await bumpGeneration(userId, id);
}

/** Move the project's setup on a generation: its ready boxes are made again
 *  (a change they're made from, or "Try again"). The new one; null when the
 *  user can't see the project. Needs write, as a change to the project does
 *  (else EnvironmentAccessError): checked first, as the function takes any id. */
export async function bumpGeneration(userId: string, id: string): Promise<number | null> {
  const level = await environmentLevel(userId, id);
  if (!level) return null;
  if (!allows(level, "write")) throw new EnvironmentAccessError();
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc("bump_environment_generation", { target: id });
  // Before the migration that adds it: nothing to make again.
  if (error && (error.code === "PGRST202" || error.code === "42883")) return null;
  if (error) throw error;
  return typeof data === "number" ? data : null;
}

/** Record a member's warm hook run on their ready boxes, for the settings
 *  page (record_warm_run: a failure of a generation isn't hidden by their
 *  other box's success). */
export async function recordWarmRun(id: string, memberId: string, run: WarmRun): Promise<void> {
  const { error } = await createSupabaseAdminClient().rpc("record_warm_run", { target: id, member: memberId, run });
  if (error) throw error;
}

/** A member's warm run, read defensively from the project's map. */
function warmRunOf(runs: unknown, memberId: string): WarmRun | null {
  const run = runs && typeof runs === "object" ? (runs as Record<string, unknown>)[memberId] : null;
  if (!run || typeof run !== "object") return null;
  const r = run as Record<string, unknown>;
  if (r.status !== "running" && r.status !== "succeeded" && r.status !== "failed") return null;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    status: r.status,
    log: text(r.log),
    startedAt: text(r.startedAt),
    finishedAt: text(r.finishedAt),
    generation: typeof r.generation === "number" ? r.generation : null,
  };
}

/** Another save kept changing the project's secrets while this one tried
 *  to; nothing of this one was saved. */
export class EnvironmentConflictError extends Error {
  constructor() {
    super("The environment changed while saving. Try again.");
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
    if (written.length > 0) {
      // Ready boxes carry the variables and files they were warmed with.
      await bumpGeneration(userId, id);
      return { envNames, filePaths };
    }
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

/** The generation of the project's setup a ready box must be made from to be
 *  taken; null for no project (any box, then). */
export async function setupGeneration(userId: string, id: string | null): Promise<number | null> {
  if (!id || !(await environmentLevel(userId, id))) return null;
  const { data, error } = await createSupabaseAdminClient()
    .from("environments")
    .select("setup_generation")
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
 *  another org. Needs write on the project (else EnvironmentAccessError),
 *  and on the repository: a project's level is its repositories' lowest, so
 *  adding one the user only reads would leave them unable to change it. */
export async function addEnvironmentRepo(userId: string, id: string, projectId: string): Promise<void> {
  const environment = await getEnvironment(userId, id);
  if (!environment) throw new EnvironmentRuleError("Environment not found.");
  if (!allows(environment.access, "write")) throw new EnvironmentAccessError();
  const repoLevel = await projectLevel(userId, projectId);
  if (!repoLevel) throw new EnvironmentRuleError("That repository isn't connected to this environment's organization.");
  if (!allows(repoLevel, "write")) {
    throw new EnvironmentRuleError("You can only add a repository you can change. Ask an admin for write access on it.");
  }
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
  if (!project) throw new EnvironmentRuleError("That repository isn't connected to this environment's organization.");
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
    throw new EnvironmentRuleError("The environment changed while adding that repository. Try again.");
  }
  if (insertError) throw insertError;
}

/** Remove a repository from the project; never its last, nor the one a
 *  repository's default project is for (it would no longer be that one's).
 *  Needs write on the project (else EnvironmentAccessError). */
export async function removeEnvironmentRepo(userId: string, id: string, projectId: string): Promise<void> {
  const environment = await getEnvironment(userId, id);
  if (!environment) throw new EnvironmentRuleError("Environment not found.");
  if (!allows(environment.access, "write")) throw new EnvironmentAccessError();
  if (environment.repos.length <= 1) throw new EnvironmentRuleError("An environment keeps at least one repository.");
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

/**
 * A project the user makes, of some of the org's repositories (in the order
 * given, each in a folder named after it), with no default repository: the
 * API's (POST /environments). Needs write on every repository; each must be
 * the org's.
 */
export async function createEnvironment(userId: string, orgId: string, name: string, projectIds: string[]): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw new EnvironmentRuleError("A project's name is 1 to 80 characters.");
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) throw new EnvironmentRuleError("A project holds at least one repository.");
  if (ids.length > MAX_REPOS) throw new EnvironmentRuleError(`A project holds at most ${MAX_REPOS} repositories.`);
  const supabase = createSupabaseAdminClient();
  const { data: projects, error } = await supabase.from("projects").select("id, name").eq("org_id", orgId).in("id", ids);
  if (error) throw error;
  const byId = new Map<string, string>((projects ?? []).map((p) => [String(p.id), String(p.name)]));
  for (const id of ids) {
    if (!byId.has(id)) throw new EnvironmentRuleError("That repository isn't connected to this organization.");
    if (!allows(await projectLevel(userId, id), "write")) {
      throw new EnvironmentRuleError("You can only make a project of repositories you can change. Ask an admin for write access.");
    }
  }
  const { data: made, error: insertError } = await supabase
    .from("environments")
    .insert({ owner_id: userId, org_id: orgId, name: trimmed })
    .select("id")
    .single();
  if (insertError) throw insertError;
  const id = made.id as string;
  const taken = new Set<string>();
  const rows = ids.map((projectId, position) => {
    const base = checkoutNameFor(byId.get(projectId)!);
    let folder = base;
    for (let n = 2; taken.has(folder); n++) folder = `${base.slice(0, 96)}-${n}`;
    taken.add(folder);
    return { owner_id: userId, environment_id: id, project_id: projectId, checkout_name: folder, position };
  });
  const { error: reposError } = await supabase.from("environment_repos").insert(rows);
  if (reposError) {
    // Not left half made: a project with none of its repositories.
    await supabase.from("environments").delete().eq("id", id);
    throw reposError;
  }
  return id;
}

/**
 * Archive a project the user made: it's no longer listed or started from,
 * and its sessions keep their own copy of its setup. A repository's own
 * project isn't one to remove. Needs write (else EnvironmentAccessError).
 */
export async function archiveEnvironment(userId: string, id: string): Promise<void> {
  const environment = await getEnvironment(userId, id);
  if (!environment) throw new EnvironmentRuleError("Environment not found.");
  if (!allows(environment.access, "write")) throw new EnvironmentAccessError();
  if (environment.defaultForProjectId) {
    throw new EnvironmentRuleError("This project is its repository's own, and goes only with the repository.");
  }
  const { error } = await createSupabaseAdminClient()
    .from("environments")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .is("archived_at", null);
  if (error) throw error;
}
