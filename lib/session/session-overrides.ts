/**
 * What one session is given for itself, beyond its project's
 * (lib/db/environments.ts): variables, MCP servers and subagents named when
 * it's started through the API (POST /workspaces `env`, `mcp_servers`,
 * `subagents`; Cursor's `envVars`, `mcpServers`, `customSubagents`). Kept
 * sealed with the session (lib/db/session-overrides.ts), and laid over its
 * project's setup at every setup of its box, its start and each restore
 * (lib/runtime/session-setup.deps.ts): the session's win on a name both have.
 *
 * Pure (no Node, no database): the API's checks and the setup's merge.
 */

import type { AgentConfig } from "@/lib/db/agent-config";
import type { EnvironmentSetup } from "@/lib/db/environments";
import { claudeMcpServer, MAX_MCP_SERVERS, newMcpServer } from "@/lib/environments/mcp";
import { EnvironmentRuleError, MAX_ENV_BYTES, utf8Bytes } from "@/lib/environments/rules";
import { settableEnv } from "@/lib/imports/settable-env";

/** A subagent the session's agent may hand work to (Claude Code's `--agents`). */
export type Subagent = { description: string; prompt: string; model?: SubagentModel };
export type SubagentModel = "sonnet" | "opus" | "haiku" | "inherit";

export type SessionOverrides = {
  env: Record<string, string>;
  /** By name, as Claude Code's MCP config has them. */
  mcpServers: Record<string, Record<string, unknown>>;
  /** By name. */
  subagents: Record<string, Subagent>;
};

export const MAX_SESSION_ENV = 50;
const MAX_ENV_VALUE_BYTES = 4096;
export const MAX_SUBAGENTS = 20;
/** A session's subagents in all, as the box measures them: they ride on
 *  Claude's command line (runtime-agent/internal/workspace/subagents.go). */
export const MAX_SUBAGENTS_BYTES = 64 * 1024;
const MAX_DESCRIPTION = 1_000;
const MAX_SUBAGENT_PROMPT_BYTES = 32 * 1024;
const SUBAGENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Claude Code's own subagents, which a session's can't stand in for. */
const BUILT_IN_SUBAGENTS = ["general-purpose", "explore", "plan", "statusline-setup", "claude-code-guide", "output-style-setup"];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function envOf(value: unknown): Record<string, string> | string {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) return "`env` is an object of each variable's name and its value.";
  const entries = Object.entries(value);
  if (entries.length > MAX_SESSION_ENV) return `A session takes up to ${MAX_SESSION_ENV} variables of its own.`;
  for (const [name, v] of entries) {
    if (!settableEnv(name) || name.startsWith("OUTRUNNER_")) return `${name} can't be set.`;
    if (typeof v !== "string" || !v || utf8Bytes(v) > MAX_ENV_VALUE_BYTES || v.includes("\0")) {
      return `${name}'s value is 1 to ${MAX_ENV_VALUE_BYTES} bytes of text.`;
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** One server as Cursor's `mcpServers` (and the API's `mcp_servers`) give
 *  it: `type` http, sse or stdio (http with a `url`, stdio with a
 *  `command`, when left out). */
function mcpServerOf(raw: unknown, index: number): { name: string; server: Record<string, unknown> } | string {
  const which = `\`mcp_servers[${index}]\``;
  if (!isObject(raw)) return `${which} is \`{ name, url, headers }\` or \`{ name, command, args, env }\`.`;
  if (raw.auth !== undefined && raw.auth !== null) {
    return `${which}: OAuth isn't taken for a session's server; give its token in \`headers\` instead.`;
  }
  const type = raw.type ?? (raw.command !== undefined ? "stdio" : "http");
  if (type !== "http" && type !== "sse" && type !== "stdio") return `${which}'s \`type\` is http, sse or stdio.`;
  try {
    const server = newMcpServer({
      name: raw.name,
      transport: type === "stdio" ? "stdio" : "http",
      ...(type === "stdio" ? { command: raw.command, args: raw.args, env: raw.env } : { url: raw.url, headers: raw.headers }),
    });
    const shaped = claudeMcpServer(server);
    return { name: server.name, server: type === "sse" ? { ...shaped, type: "sse" } : shaped };
  } catch (error) {
    if (error instanceof EnvironmentRuleError) return `${which}: ${error.message}`;
    throw error;
  }
}

function mcpServersOf(value: unknown): Record<string, Record<string, unknown>> | string {
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value)) return "`mcp_servers` is a list of servers.";
  if (value.length > MAX_MCP_SERVERS) return `A session takes up to ${MAX_MCP_SERVERS} servers of its own.`;
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [index, raw] of value.entries()) {
    const read = mcpServerOf(raw, index);
    if (typeof read === "string") return read;
    if (servers[read.name]) return `Two servers are named ${read.name}.`;
    servers[read.name] = read.server;
  }
  return servers;
}

/** A subagent's model as Claude Code takes it: a family, from an id that
 *  names one (`claude-sonnet-4-5`, `opus`), or `inherit`; none for another. */
export function subagentModel(value: unknown): SubagentModel | undefined {
  const id = isObject(value) ? value.id : value;
  if (typeof id !== "string") return undefined;
  const lower = id.toLowerCase();
  return lower === "inherit" ? "inherit" : (["opus", "sonnet", "haiku"] as const).find((family) => lower.includes(family));
}

function subagentsOf(value: unknown): Record<string, Subagent> | string {
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value)) return "`subagents` is a list of `{ name, description, prompt, model? }`.";
  if (value.length > MAX_SUBAGENTS) return `A session takes up to ${MAX_SUBAGENTS} subagents of its own.`;
  const subagents: Record<string, Subagent> = {};
  for (const [index, raw] of value.entries()) {
    const which = `\`subagents[${index}]\``;
    if (!isObject(raw)) return `${which} is \`{ name, description, prompt, model? }\`.`;
    const name = typeof raw.name === "string" ? raw.name.trim().toLowerCase() : "";
    if (!SUBAGENT_NAME.test(name)) return `${which}'s \`name\` is up to 64 lowercase letters, digits and -.`;
    if (BUILT_IN_SUBAGENTS.includes(name)) return `${name} is one of Claude Code's own subagents: name yours another way.`;
    if (subagents[name]) return `Two subagents are named ${name}.`;
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    if (!description || description.length > MAX_DESCRIPTION) return `${which}'s \`description\` says when to use it, in up to ${MAX_DESCRIPTION} characters.`;
    const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
    if (!prompt || utf8Bytes(prompt) > MAX_SUBAGENT_PROMPT_BYTES || prompt.includes("\0")) return `${which}'s \`prompt\` is its instructions, up to 32 KB.`;
    const model = subagentModel(raw.model);
    subagents[name] = { description, prompt, ...(model && { model }) };
  }
  if (goJsonBytes(subagents) > MAX_SUBAGENTS_BYTES) return `A session's subagents take up to ${MAX_SUBAGENTS_BYTES / 1024} KB in all: shorten their prompts.`;
  return subagents;
}

/** `value`'s size as Go's encoding/json writes it, which also escapes <, >
 *  and & (as \u003c: 6 bytes) and U+2028/U+2029. */
export function goJsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  const escaped = (json.match(/[<>&]/g)?.length ?? 0) * 5 + (json.match(/[\u2028\u2029]/g)?.length ?? 0) * 3;
  return utf8Bytes(json) + escaped;
}

/** A start request's `env`, `mcp_servers` and `subagents`, checked; null
 *  for none of them; or the reason they're refused. */
export function parseSessionOverrides(raw: { env?: unknown; mcp_servers?: unknown; subagents?: unknown }): SessionOverrides | null | string {
  const env = envOf(raw.env);
  if (typeof env === "string") return env;
  const mcpServers = mcpServersOf(raw.mcp_servers);
  if (typeof mcpServers === "string") return mcpServers;
  const subagents = subagentsOf(raw.subagents);
  if (typeof subagents === "string") return subagents;
  return isEmpty({ env, mcpServers, subagents }) ? null : { env, mcpServers, subagents };
}

export function isEmpty(overrides: SessionOverrides): boolean {
  return !Object.keys(overrides.env).length && !Object.keys(overrides.mcpServers).length && !Object.keys(overrides.subagents).length;
}

/** The project's setup with the session's variables over its own. */
export function withSessionEnvironment(environment: EnvironmentSetup | null, overrides: SessionOverrides): EnvironmentSetup {
  return {
    env: { ...(environment?.env ?? {}), ...overrides.env },
    files: environment?.files ?? {},
    setup: environment?.setup ?? null,
    run: environment?.run ?? null,
    archive: environment?.archive ?? null,
    instructions: environment?.instructions ?? null,
    ...(environment?.hooks && { hooks: environment.hooks }),
    ...(environment?.generation !== undefined && { generation: environment.generation }),
  };
}

/** The agent setup with the session's MCP servers over the project's and the
 *  user's (Outrunner's own go over them all, after). */
export function withSessionServers(config: AgentConfig | null, overrides: SessionOverrides): AgentConfig | null {
  if (Object.keys(overrides.mcpServers).length === 0) return config;
  return {
    archive: config?.archive ?? null,
    items: config?.items ?? [],
    settings: config?.settings ?? {},
    mcpServers: { ...(config?.mcpServers ?? {}), ...overrides.mcpServers },
  };
}

/** The project's setup between its org's secrets and its user's own: the
 *  org's under the project's variables, the user's over them (the session's
 *  own go over all, after: withSessionEnvironment). */
export function withScopedSecrets(
  environment: EnvironmentSetup | null,
  scoped: { team: Record<string, string>; personal: Record<string, string> },
): EnvironmentSetup | null {
  if (!Object.keys(scoped.team).length && !Object.keys(scoped.personal).length) return environment;
  const base = withSessionEnvironment(environment, { env: {}, mcpServers: {}, subagents: {} });
  return { ...base, env: { ...scoped.team, ...base.env, ...scoped.personal } };
}

/** Whether a secret for `repos` (none: all) is for a session of `fullNames`. */
export function coversRepos(repos: readonly string[], fullNames: readonly string[]): boolean {
  if (repos.length === 0) return true;
  const wanted = new Set(fullNames.map((n) => n.toLowerCase()));
  return repos.some((r) => wanted.has(r.toLowerCase().replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "")));
}

/** The size of the variables file a box writes for `env`: an `export
 *  NAME='value'` line each (runtime-agent/internal/workspace/environment.go,
 *  which takes at most MAX_ENV_BYTES). */
export function envFileBytes(env: Record<string, string>): number {
  return Object.entries(env).reduce((n, [name, value]) => n + utf8Bytes(`export ${name}='${value.replace(/'/g, "'\\''")}'\n`), 0);
}

/** Why a session's variables, all laid together, are more than its box
 *  takes; null when they fit. */
export function oversizedEnv(environment: EnvironmentSetup | null): string | null {
  const bytes = environment ? envFileBytes(environment.env) : 0;
  if (bytes <= MAX_ENV_BYTES) return null;
  return `This session's variables come to ${Math.ceil(bytes / 1024)} KB, over the ${MAX_ENV_BYTES / 1024} KB a box takes: its project's, its org's secrets, yours and its own together. Remove some of them.`;
}
