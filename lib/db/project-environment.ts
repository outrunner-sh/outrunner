/**
 * A project's environment for its cloud sessions (project_environment): its
 * variables and its checkout's .env files, sealed, and its setup, run and
 * archive scripts. Service role
 * only — the table has no policy — and always scoped to the owner here.
 */

import { open, seal } from "@/lib/crypto/secret-box";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type ProjectScripts = { setup: string | null; run: string | null; archive: string | null };

export type ProjectEnvironment = ProjectScripts & {
  /** The variables, opened. */
  env: Record<string, string>;
  /** The files, by path in the checkout, opened. */
  files: Record<string, string>;
};

/** The project's environment, or null when it has none (or before the
 *  migration that adds it). A sealed value that no longer opens reads as no
 *  variables rather than failing the session. */
export async function getProjectEnvironment(ownerId: string, projectId: string): Promise<ProjectEnvironment | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("project_environment")
    .select("secrets_ciphertext, setup_script, run_script, archive_script")
    .eq("owner_id", ownerId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (error && probeStatus(error) === "missing") return null;
  if (error) throw error;
  if (!data) return null;
  let secrets: { env?: Record<string, string>; files?: Record<string, string> } = {};
  if (data.secrets_ciphertext) {
    try {
      secrets = JSON.parse(open(data.secrets_ciphertext)) as typeof secrets;
    } catch (cause) {
      console.error(`Project ${projectId}'s environment can't be opened`, cause);
    }
  }
  return {
    env: secrets.env ?? {},
    files: secrets.files ?? {},
    setup: data.setup_script,
    run: data.run_script,
    archive: data.archive_script,
  };
}

/** Whether the owner has kept any environment for the project; false before
 *  the migration that adds it. Reads no secrets. */
export async function hasProjectEnvironment(ownerId: string, projectId: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient()
    .from("project_environment")
    .select("project_id")
    .eq("owner_id", ownerId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (error && probeStatus(error) === "missing") return false;
  if (error) throw error;
  return data !== null;
}

/** Add variables, files and scripts to a project's environment: a variable
 *  of the same name, a file at the same path, or a script given, replaces the
 *  one there. */
export async function mergeProjectEnvironment(
  ownerId: string,
  projectId: string,
  add: { env?: Record<string, string>; files?: Record<string, string>; scripts?: Partial<ProjectScripts> },
): Promise<void> {
  const current = await getProjectEnvironment(ownerId, projectId);
  const env = { ...(current?.env ?? {}), ...(add.env ?? {}) };
  const files = { ...(current?.files ?? {}), ...(add.files ?? {}) };
  const names = Object.keys(env).sort();
  const paths = Object.keys(files).sort();
  const scripts = { setup: current?.setup ?? null, run: current?.run ?? null, archive: current?.archive ?? null, ...add.scripts };
  const { error } = await createSupabaseAdminClient()
    .from("project_environment")
    .upsert(
      {
        owner_id: ownerId,
        project_id: projectId,
        secrets_ciphertext: names.length + paths.length > 0 ? seal(JSON.stringify({ env, files })) : null,
        env_names: names,
        file_paths: paths,
        setup_script: scripts.setup,
        run_script: scripts.run,
        archive_script: scripts.archive,
      },
      { onConflict: "owner_id,project_id" },
    );
  if (error) throw error;
}
