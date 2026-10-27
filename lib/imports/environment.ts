/**
 * Keeping what the user picked of a repository's environment on their Mac —
 * Conductor's variables, the checkout's .env files, Conductor's scripts — for
 * its cloud sessions, sealed (lib/db/project-environment.ts). A variable a
 * session can't be given (its PATH, its credentials) is left out and said.
 *
 * Its collaborators are passed in, so it tests without Next or a database.
 */

import { MAX_ENV_BYTES, MAX_FILES, MAX_FILES_BYTES, MAX_SCRIPT_BYTES, envBytes } from "@/lib/environments/rules";
import { ImportError } from "@/lib/imports/commit";
import { settableEnv } from "@/lib/imports/settable-env";
import type { ImportEnvironmentRequest } from "@/lib/runtime/import-scan";

export { RESERVED_ENV, settableEnv } from "@/lib/imports/settable-env";

export type EnvironmentDeps = {
  /** The owner's project for the repository, connected if it isn't yet; null
   *  when their GitHub can't see it. */
  projectFor(repo: string): Promise<string | null>;
  merge(
    projectId: string,
    add: { env: Record<string, string>; files: Record<string, string>; scripts: Record<string, string> },
  ): Promise<void>;
};

export async function importEnvironment(
  req: ImportEnvironmentRequest,
  deps: EnvironmentDeps,
): Promise<{ projectId: string; refused: string[] }> {
  const env: Record<string, string> = {};
  const refused: string[] = [];
  for (const [name, value] of Object.entries(req.env)) {
    if (settableEnv(name) && !value.includes("\0")) env[name] = value;
    else refused.push(name);
  }
  const files = Object.entries(req.files);
  const filesBytes = files.reduce((n, [, content]) => n + content.length, 0);
  const scripts = Object.fromEntries(Object.entries(req.scripts ?? {}).filter(([, v]) => v)) as Record<string, string>;
  if (
    envBytes(env) > MAX_ENV_BYTES ||
    files.length > MAX_FILES ||
    filesBytes > MAX_FILES_BYTES ||
    Object.values(scripts).some((script) => script.length > MAX_SCRIPT_BYTES)
  ) {
    throw new ImportError("That environment is larger than a cloud session takes.", 413);
  }

  const projectId = await deps.projectFor(req.repo);
  if (!projectId) throw new ImportError(`Your GitHub account can't see ${req.repo}.`, 404);
  await deps.merge(projectId, { env, files: req.files, scripts });
  return { projectId, refused };
}
