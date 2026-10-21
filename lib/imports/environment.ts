/**
 * Keeping what the user picked of a repository's environment on their Mac —
 * Conductor's variables, the checkout's .env files, Conductor's scripts — for
 * its cloud sessions, sealed (lib/db/project-environment.ts). A variable a
 * session can't be given (its PATH, its credentials) is left out and said.
 *
 * Its collaborators are passed in, so it tests without Next or a database.
 */

import { ImportError } from "@/lib/imports/commit";
import type { ImportEnvironmentRequest } from "@/lib/runtime/import-scan";

/** Variables a session's environment may not set: the agent refuses them
 *  too (runtime-agent/internal/workspace/environment.go, checked against
 *  this list by its tests through agent-protocol.fixtures.json). */
export const RESERVED_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "TMPDIR", "LANG", "TERM", "TMUX", "TMUX_PANE",
  "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL", "OPENAI_API_KEY", "CODEX_HOME", "DISABLE_AUTOUPDATER",
] as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Whether a session's environment may set `name`. */
export function settableEnv(name: string): boolean {
  return ENV_NAME.test(name) && !(RESERVED_ENV as readonly string[]).includes(name) && !name.startsWith("RUNTIME_");
}

/** The bounds the agent holds a session's environment to. */
const MAX_ENV_BYTES = 256 * 1024;
const MAX_FILES = 100;
const MAX_FILES_BYTES = 1024 * 1024;
const MAX_SCRIPT_BYTES = 64 * 1024;

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
  const envBytes = Object.entries(env).reduce((n, [k, v]) => n + k.length + v.length + 16, 0);
  const files = Object.entries(req.files);
  const filesBytes = files.reduce((n, [, content]) => n + content.length, 0);
  const scripts = Object.fromEntries(Object.entries(req.scripts ?? {}).filter(([, v]) => v)) as Record<string, string>;
  if (
    envBytes > MAX_ENV_BYTES ||
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
