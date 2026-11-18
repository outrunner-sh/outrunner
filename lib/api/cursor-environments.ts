/**
 * Cursor's environments and secrets (api.cursor.com/v1/environments,
 * /v1/secrets, /v1/team/secrets, /v1/me/secrets), as Outrunner's projects
 * and secrets say them, the part with no network.
 *
 * A Cursor environment is an Outrunner project (lib/db/environments.ts): its
 * repositories, and its `environmentJson` the project's hooks: `install` the
 * warm hook, run once ahead on a ready box (Cursor's cached install), and
 * `start` the start hook, run at each launch, with `terminals` started from
 * it in the background. A build is the project's ready boxes being made
 * (its setup generation, and the warm hook's last run on the caller's).
 * Its history is its changes in the org's audit log (lib/audit/project-history.ts).
 */

import type { AuditEvent } from "@/lib/audit/actions";
import type { Environment, ProjectHooks } from "@/lib/db/environments";
import type { ScopedSecret, SecretType } from "@/lib/db/scoped-secrets";
import { repoAddress } from "@/lib/api/cursor";
import { repoFullName } from "@/lib/api/repo-ref";
import { utf8Bytes } from "@/lib/environments/rules";
import { isObject } from "@/lib/is-object";

/** Shell-quoted, for a command line. */
function quoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A terminal as the start hook starts it: in the background, its output in
 *  a log of its name, so the launch goes on. */
function terminalLine(name: string, command: string): string {
  const file = name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "terminal";
  return `nohup sh -c ${quoted(command)} > /tmp/terminal-${file}.log 2>&1 &`;
}

/** Cursor's `environmentJson` (a JSON string, as `.cursor/environment.json`;
 *  an object is taken too) as the project's hooks, or the reason it's
 *  refused. */
export function hooksFromEnvironmentJson(value: unknown): ProjectHooks | string {
  let json: unknown = value;
  if (typeof value === "string") {
    try {
      json = JSON.parse(value);
    } catch {
      return "`environmentJson` is JSON, as .cursor/environment.json holds.";
    }
  }
  if (!isObject(json)) return "`environmentJson` is an object: `install`, `start`, `terminals`.";
  if (json.build !== undefined || json.dockerfile !== undefined || json.snapshot !== undefined) {
    return "Sessions here all start from Outrunner's box image: there's no Dockerfile or snapshot to build. Install what you need in `install`.";
  }
  for (const key of ["install", "start"]) {
    if (json[key] !== undefined && json[key] !== null && typeof json[key] !== "string") return `\`environmentJson.${key}\` is a shell command.`;
  }
  const lines: string[] = [];
  if (typeof json.start === "string" && json.start.trim()) lines.push(json.start.trim());
  if (json.terminals !== undefined && json.terminals !== null) {
    if (!Array.isArray(json.terminals)) return "`environmentJson.terminals` is a list of `{ name, command }`.";
    for (const [index, terminal] of json.terminals.entries()) {
      if (!isObject(terminal) || typeof terminal.command !== "string" || !terminal.command.trim()) {
        return `\`environmentJson.terminals[${index}]\` is \`{ name, command }\`.`;
      }
      lines.push(terminalLine(typeof terminal.name === "string" ? terminal.name : `terminal-${index + 1}`, terminal.command.trim()));
    }
  }
  const install = typeof json.install === "string" && json.install.trim() ? json.install.trim() : null;
  return { warm: install, start: lines.length ? lines.join("\n") : null };
}

/** The project's hooks as Cursor's `environmentJson`. */
export function environmentJsonOf(hooks: ProjectHooks): string {
  return JSON.stringify({ ...(hooks.warm && { install: hooks.warm }), ...(hooks.start && { start: hooks.start }) });
}

/** Cursor's `repos` (`[{ url }]`) as repositories' full names, or the reason
 *  they're refused. */
export function repoNamesOf(value: unknown): string[] | string {
  if (!Array.isArray(value) || value.length === 0) return "`repos` is a list of `{ url }`, at least one.";
  const names: string[] = [];
  for (const [index, repo] of value.entries()) {
    const url = isObject(repo) ? repo.url : repo;
    const name = repoFullName(url);
    if (!name) return `\`repos[${index}].url\` is the address of a repository on GitHub or GitLab.com.`;
    names.push(name);
  }
  return names;
}

/** Defaults Cursor's builds answer with: Outrunner's ready boxes are made
 *  again on each change, not on a schedule. */
export const BUILD_SETTINGS = { pullLatestCode: "when_stale", stalenessThresholdHours: null, installTimeoutMinutes: null } as const;

/** A project as Cursor's environment; in full (GET one) with its
 *  `environmentJson` and `buildSettings`. `personal`: its org is its maker's
 *  own (Cursor's `owner: personal`), else the team's. */
export function cursorEnvironmentJson(environment: Environment, personal: boolean, full: boolean): Record<string, unknown> {
  return {
    id: environment.id,
    name: environment.name,
    owner: personal ? "personal" : "team",
    repos: environment.repos.map((r) => ({ url: `https://${repoAddress(r.fullName)}` })),
    ...(full && {
      environmentJson: environmentJsonOf(environment.hooks),
      versionId: `gen-${environment.setupGeneration}`,
      buildSettings: BUILD_SETTINGS,
    }),
    createdAt: environment.createdAt ?? environment.updatedAt,
    updatedAt: environment.updatedAt,
  };
}

const HISTORY_KIND: Record<string, string> = {
  "project.created": "created",
  "project.changed": "updated",
  "project.deleted": "deleted",
};

/** A project's change (its audit event) as Cursor's history item. The
 *  newest (`current`) is the project as it is. */
export function historyItemJson(event: AuditEvent, describe: string, current: boolean): Record<string, unknown> {
  const hooks = isObject(event.details.hooks) ? (event.details.hooks as ProjectHooks) : null;
  return {
    id: String(event.id),
    createdAt: event.createdAt,
    kind: HISTORY_KIND[event.action] ?? "changed",
    title: `${event.actorLabel} ${describe}`,
    description: describe,
    source: event.actorType === "system" ? "SYSTEM" : "API",
    current,
    ...(hooks && { environmentJson: environmentJsonOf({ warm: hooks.warm ?? null, start: hooks.start ?? null }) }),
  };
}

const BUILD_STATUS = { running: "IN_PROGRESS", succeeded: "SUCCEEDED", failed: "FAILED" } as const;

/** The project's build: its ready boxes for its setup generation, and how
 *  its warm hook went on the caller's. Null before it's ever been made. */
export function cursorBuildJson(environment: Environment): Record<string, unknown> | null {
  const warm = environment.warm;
  const generation = environment.setupGeneration;
  // A project with no warm hook has nothing to build: its boxes are made as they are.
  const status = warm && warm.generation === generation ? BUILD_STATUS[warm.status] : environment.hooks.warm ? "IN_PROGRESS" : "SKIPPED";
  return {
    id: buildId(generation),
    environmentId: environment.id,
    status,
    trigger: "CONFIG_CHANGE",
    source: "SYSTEM",
    draft: false,
    ...(status === "FAILED" && { failure: { type: "INSTALL_FAILED" } }),
    requestedRefs: environment.repos.map((r) => ({ repoUrl: repoAddress(r.fullName), ref: r.branch ?? r.defaultBranch })),
    repoCommits: [],
    createdAt: (warm?.generation === generation && warm.startedAt) || environment.updatedAt,
    updatedAt: (warm?.generation === generation && (warm.finishedAt ?? warm.startedAt)) || environment.updatedAt,
    ...(warm?.generation === generation && warm.finishedAt && { completedAt: warm.finishedAt }),
  };
}

export function buildId(generation: number): string {
  return `bld-${generation}`;
}

/** A secret as Cursor lists one (never its value), and whose it is. */
export function secretVersionJson(secret: ScopedSecret, owner?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `secv_${secret.id.replace(/-/g, "")}`,
    name: secret.name,
    type: secret.type,
    repos: secret.repos,
    createdAt: secret.createdAt,
    ...(owner && { owner }),
  };
}

/** A project's variable, as Cursor's environment secret: its name alone is kept apart. */
export function projectSecretJson(environment: Environment, name: string, owner?: boolean): Record<string, unknown> {
  return {
    id: `secv_${environment.id.replace(/-/g, "").slice(0, 16)}_${name}`,
    name,
    type: "runtime_secret",
    repos: [],
    createdAt: environment.updatedAt,
    ...(owner && { owner: { type: "environment", environmentId: environment.id } }),
  };
}

export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_SECRET_BYTES = 4096;

/** A secret's PUT body (`value`, `type`, `repos`), checked; or the reason
 *  it's refused. */
export function secretPutOf(body: Record<string, unknown>): { value: string; type?: SecretType; repos?: string[] } | string {
  if (typeof body.value !== "string" || !body.value || utf8Bytes(body.value) > MAX_SECRET_BYTES || body.value.includes("\0")) {
    return `\`value\` is 1 to ${MAX_SECRET_BYTES} bytes of text.`;
  }
  if (body.type !== undefined && body.type !== "runtime_secret" && body.type !== "environment_variable") {
    return body.type === "build_secret" ? "Build secrets aren't set through the API." : "`type` is runtime_secret or environment_variable.";
  }
  let repos: string[] | undefined;
  if (body.repos !== undefined) {
    if (!Array.isArray(body.repos) || body.repos.length > 100) return "`repos` is a list of up to 100 repositories.";
    repos = [];
    for (const repo of body.repos) {
      const name = repoFullName(repo);
      if (!name) return `${String(repo)} isn't a repository's address.`;
      repos.push(name.toLowerCase());
    }
  }
  return { value: body.value, ...(body.type !== undefined && { type: body.type as SecretType }), ...(repos && { repos }) };
}

/** What changing a project's repositories to `wanted` takes, or why it
 *  can't: a project holds 1 to MAX_REPOS, and a repository's own project
 *  keeps that repository. */
export function reposPlan(
  project: Pick<Environment, "repos" | "defaultForProjectId">,
  wanted: readonly string[],
  maxRepos: number,
): { add: string[]; remove: string[] } | string {
  if (wanted.length === 0) return "A project holds at least one repository.";
  if (wanted.length > maxRepos) return `A project holds at most ${maxRepos} repositories.`;
  if (project.defaultForProjectId && !wanted.includes(project.defaultForProjectId)) {
    return "This project is its repository's own: keep that repository in `repos`.";
  }
  const have = project.repos.map((r) => r.projectId);
  return { add: wanted.filter((p) => !have.includes(p)), remove: have.filter((p) => !wanted.includes(p)) };
}
