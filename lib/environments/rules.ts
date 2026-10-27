/**
 * The rules a Project (an `environments` row, 20261027120000_environments.sql)
 * is kept to: its name and instructions, its variables and files, its
 * scripts, and how many repositories it holds. The bounds are the ones the
 * runtime-agent holds a session's environment to
 * (runtime-agent/internal/workspace/environment.go), so nothing saved here is
 * refused when a session starts.
 *
 * Pure (no Node, no database), so the page checks what the server will and
 * both are unit-tested.
 */

import { settableEnv } from "@/lib/imports/settable-env";

/** Repositories a project holds at most: each is cloned on every box. */
export const MAX_REPOS = 5;

export const MAX_NAME = 80;
export const MAX_DESCRIPTION = 500;
export const MAX_INSTRUCTIONS = 16 * 1024;

/** The agent's bounds on a session's environment. */
export const MAX_ENV_BYTES = 256 * 1024;
export const MAX_FILES = 100;
export const MAX_FILES_BYTES = 1024 * 1024;
export const MAX_SCRIPT_BYTES = 64 * 1024;

/** The secrets a project keeps sealed: its variables, and its files by path
 *  in the checkout. */
export type EnvironmentSecrets = { env: Record<string, string>; files: Record<string, string> };

/** A change to a project's secrets: values set (added, or replacing one of
 *  the same name or path) and names or paths removed. */
export type SecretsEdit = {
  setEnv?: Record<string, string>;
  removeEnv?: string[];
  setFiles?: Record<string, string>;
  removeFiles?: string[];
};

/** A refused change; its message is a sentence for the page. */
export class EnvironmentRuleError extends Error {}

/** The folder a repository is cloned into, from its name: what a checkout
 *  name may hold (environment_repos_checkout_name_check). */
export function checkoutNameFor(repoName: string): string {
  const name = repoName.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100);
  return name === "" || name === "." || name === ".." ? "repo" : name;
}

/** A string's length as the agent measures it: UTF-8 bytes, not the UTF-16
 *  units `.length` counts, so non-ASCII text isn't let through here and
 *  refused when a session starts. */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** The bytes the agent counts for a set of variables: each `export NAME='value'` line. */
export function envBytes(env: Record<string, string>): number {
  return Object.entries(env).reduce((n, [k, v]) => n + utf8Bytes(k) + utf8Bytes(v) + 16, 0);
}

/** A file's path as the agent takes it: relative, inside the checkout,
 *  already clean. */
export function validFilePath(path: string): boolean {
  if (path === "" || path.length > 1024 || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Apply an edit, refusing one that leaves a variable a session can't set,
 *  a bad path, or more than a session takes. */
export function applySecretsEdit(current: EnvironmentSecrets, edit: SecretsEdit): EnvironmentSecrets {
  const env = { ...current.env };
  for (const name of edit.removeEnv ?? []) delete env[name];
  for (const [name, value] of Object.entries(edit.setEnv ?? {})) {
    if (!settableEnv(name)) throw new EnvironmentRuleError(`${name} can't be set: it isn't a variable name, or a session sets it itself.`);
    if (value.includes("\0")) throw new EnvironmentRuleError(`${name}'s value can't hold a NUL.`);
    env[name] = value;
  }
  const files = { ...current.files };
  for (const path of edit.removeFiles ?? []) delete files[path];
  for (const [path, content] of Object.entries(edit.setFiles ?? {})) {
    if (!validFilePath(path)) throw new EnvironmentRuleError(`${path} isn't a path inside the repository.`);
    files[path] = content;
  }
  if (envBytes(env) > MAX_ENV_BYTES) throw new EnvironmentRuleError("Those variables are larger than a session takes (256 KB).");
  const paths = Object.keys(files);
  if (paths.length > MAX_FILES) throw new EnvironmentRuleError(`A project keeps at most ${MAX_FILES} files.`);
  if (Object.values(files).reduce((n, c) => n + utf8Bytes(c), 0) > MAX_FILES_BYTES) {
    throw new EnvironmentRuleError("Those files are larger than a session takes (1 MB).");
  }
  return { env, files };
}

/** Instructions, trimmed, empty as null: at most 16 KB, measured as the
 *  agent measures them. */
export function instructionsText(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (utf8Bytes(trimmed) > MAX_INSTRUCTIONS || trimmed.includes("\0")) {
    throw new EnvironmentRuleError("The instructions are larger than a session takes (16 KB).");
  }
  return trimmed === "" ? null : trimmed;
}

/** A name, trimmed, or why it can't be one. */
export function projectName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new EnvironmentRuleError("Give the project a name.");
  if (trimmed.length > MAX_NAME) throw new EnvironmentRuleError(`A project's name is at most ${MAX_NAME} characters.`);
  return trimmed;
}

/** Optional text, trimmed, empty as null, or why it's too long. */
export function optionalText(value: string | null, max: number, what: string): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length > max) throw new EnvironmentRuleError(`${what} is at most ${max.toLocaleString("en")} characters.`);
  return trimmed === "" ? null : trimmed;
}

/** A script as saved: blank is none. Kept as written otherwise (a shebang,
 *  trailing newline and all). */
export function script(value: string | null, what: string): string | null {
  if (value === null || value.trim() === "") return null;
  if (utf8Bytes(value) > MAX_SCRIPT_BYTES || value.includes("\0")) {
    throw new EnvironmentRuleError(`The ${what} is larger than a session takes (64 KB).`);
  }
  return value;
}

/**
 * The variables in pasted `.env` text: `NAME=value` lines, `export` before
 * one allowed, a value in single or double quotes unquoted (double-quoted
 * escapes \n, \" and \\ read), `#` comments and blank lines skipped. Lines
 * that aren't a variable are returned apart, so the page can say which.
 */
export function parseDotenv(text: string): { env: Record<string, string>; skipped: string[] } {
  const env: Record<string, string> = {};
  const skipped: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      skipped.push(line);
      continue;
    }
    env[match[1]] = dotenvValue(match[2]);
  }
  return { env, skipped };
}

function dotenvValue(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(n|"|\\)/g, (_, c: string) => (c === "n" ? "\n" : c));
  }
  // Unquoted: a comment after whitespace isn't part of it.
  return value.replace(/\s+#.*$/, "");
}
