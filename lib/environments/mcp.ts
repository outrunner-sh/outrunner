/**
 * The rules a project's MCP servers are kept to
 * (20261103131000_environment_mcp_servers.sql): a stdio server, a command
 * the box runs with its arguments and environment, or an http one, a URL
 * with headers. Every session of the project loads them, in Claude Code and
 * Codex, beside the user's own servers; theirs win on a name both have.
 *
 * Names starting with "outrunner" are Outrunner's own (a Mission's tools,
 * the desktop's), which win over anything of a project's or a user's.
 *
 * Environment and header values are secrets: sealed, never shown again, and
 * masked in the session's terminal. Pure (no Node, no database), so the page,
 * the routes and the tests share it.
 */

import { EnvironmentRuleError, utf8Bytes } from "@/lib/environments/rules";

/** Servers a project holds at most: each starts in every session. */
export const MAX_MCP_SERVERS = 20;

/** The prefix of Outrunner's own servers' names. */
export const RESERVED_MCP_PREFIX = "outrunner";

export const MCP_TRANSPORTS = ["stdio", "http"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** A name Claude Code and Codex both take for a server (Codex's is a TOML
 *  table's key). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A variable a process can be given. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** An HTTP header's name (RFC 9110's token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

const MAX_COMMAND = 1024;
const MAX_ARGS = 64;
const MAX_ARG = 4096;
const MAX_VALUES = 50;
const MAX_VALUE_BYTES = 8 * 1024;
const MAX_URL = 2048;

/** A server's values that are secrets: its environment, its headers. */
export type McpSecrets = { env: Record<string, string>; headers: Record<string, string> };

/** A server as a project keeps it, its secrets apart. */
export type McpServerShape = {
  name: string;
  transport: McpTransport;
  /** stdio: what runs, and with what. Null for http. */
  command: string | null;
  args: string[];
  /** http: where it is. Null for stdio. */
  url: string | null;
};

/** A server to make: its shape and its secrets, as given. */
export type NewMcpServer = McpServerShape & McpSecrets;

/** A change to a server: a field left out is left as it is. Values set
 *  replace those of the same name; names removed go. A change of transport
 *  gives the new one's fields, and drops the old one's secrets. */
export type McpServerEdit = {
  name?: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  setEnv?: Record<string, string>;
  removeEnv?: string[];
  setHeaders?: Record<string, string>;
  removeHeaders?: string[];
};

/** A server's name, checked: one Claude Code and Codex take, not one of
 *  Outrunner's own. */
export function mcpServerName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!NAME.test(name)) {
    throw new EnvironmentRuleError("A server's name is up to 64 letters, digits, - and _, starting with a letter or digit.");
  }
  if (name.toLowerCase().startsWith(RESERVED_MCP_PREFIX)) {
    throw new EnvironmentRuleError(`Names starting with "${RESERVED_MCP_PREFIX}" are kept for Outrunner's own servers.`);
  }
  return name;
}

function transportOf(value: unknown): McpTransport {
  if (typeof value === "string" && (MCP_TRANSPORTS as readonly string[]).includes(value)) return value as McpTransport;
  throw new EnvironmentRuleError("A server is stdio (a command) or http (a URL).");
}

function commandOf(value: unknown): string {
  const command = typeof value === "string" ? value.trim() : "";
  if (!command || command.length > MAX_COMMAND || /[\0\n\r]/.test(command)) {
    throw new EnvironmentRuleError("A stdio server needs a command to run, on one line, e.g. npx.");
  }
  return command;
}

function argsOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGS || value.some((a) => typeof a !== "string" || a.length > MAX_ARG || a.includes("\0"))) {
    throw new EnvironmentRuleError(`A server takes up to ${MAX_ARGS} arguments, each text.`);
  }
  return value as string[];
}

function urlOf(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  let url: URL | null = null;
  try {
    url = text.length <= MAX_URL ? new URL(text) : null;
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new EnvironmentRuleError("An http server needs its URL, http:// or https://.");
  }
  return url.toString();
}

/** Values given for names, checked by `valid` (variables or headers). */
function valuesOf(value: unknown, valid: RegExp, what: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new EnvironmentRuleError(`Give ${what} as names and values.`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_VALUES) throw new EnvironmentRuleError(`A server takes up to ${MAX_VALUES} ${what}.`);
  for (const [name, v] of entries) {
    if (!valid.test(name)) throw new EnvironmentRuleError(`${name} can't be one of a server's ${what}.`);
    if (typeof v !== "string" || utf8Bytes(v) > MAX_VALUE_BYTES || /[\0]/.test(v) || (what === "headers" && /[\r\n]/.test(v))) {
      throw new EnvironmentRuleError(`${name}'s value is too long, or isn't text a server can take.`);
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function namesOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((n) => typeof n !== "string")) throw new EnvironmentRuleError("Name what to remove.");
  return value as string[];
}

/** A server to make, from a request's body. */
export function newMcpServer(input: Record<string, unknown>): NewMcpServer {
  const name = mcpServerName(input.name);
  const transport = transportOf(input.transport);
  if (transport === "stdio") {
    if (input.url !== undefined || input.headers !== undefined) throw new EnvironmentRuleError("A stdio server has no URL or headers.");
    return {
      name,
      transport,
      command: commandOf(input.command),
      args: argsOf(input.args),
      url: null,
      env: valuesOf(input.env, ENV_NAME, "variables"),
      headers: {},
    };
  }
  if (input.command !== undefined || input.args !== undefined || input.env !== undefined) {
    throw new EnvironmentRuleError("An http server has no command, arguments or variables.");
  }
  return { name, transport, command: null, args: [], url: urlOf(input.url), env: {}, headers: valuesOf(input.headers, HEADER_NAME, "headers") };
}

/** A change to a server, from a request's body, checked against nothing yet
 *  (applyMcpEdit checks it against the server). */
export function mcpServerEdit(input: Record<string, unknown>): McpServerEdit {
  const known = new Set(["name", "transport", "command", "args", "url", "setEnv", "removeEnv", "setHeaders", "removeHeaders"]);
  const unknown = Object.keys(input).find((k) => !known.has(k));
  if (unknown) throw new EnvironmentRuleError(`A server has no ${unknown} to change.`);
  return {
    ...(input.name !== undefined && { name: mcpServerName(input.name) }),
    ...(input.transport !== undefined && { transport: transportOf(input.transport) }),
    ...(input.command !== undefined && { command: commandOf(input.command) }),
    ...(input.args !== undefined && { args: argsOf(input.args) }),
    ...(input.url !== undefined && { url: urlOf(input.url) }),
    ...(input.setEnv !== undefined && { setEnv: valuesOf(input.setEnv, ENV_NAME, "variables") }),
    ...(input.removeEnv !== undefined && { removeEnv: namesOf(input.removeEnv) }),
    ...(input.setHeaders !== undefined && { setHeaders: valuesOf(input.setHeaders, HEADER_NAME, "headers") }),
    ...(input.removeHeaders !== undefined && { removeHeaders: namesOf(input.removeHeaders) }),
  };
}

/** A server after an edit. A new transport needs its own fields (a command,
 *  or a URL), and leaves the old one's behind. */
export function applyMcpEdit(current: NewMcpServer, edit: McpServerEdit): NewMcpServer {
  const transport = edit.transport ?? current.transport;
  const switched = transport !== current.transport;
  const next: NewMcpServer = switched
    ? { name: current.name, transport, command: null, args: [], url: null, env: {}, headers: {} }
    : { ...current, env: { ...current.env }, headers: { ...current.headers } };
  if (edit.name !== undefined) next.name = edit.name;
  if (transport === "stdio") {
    if (edit.url !== undefined || edit.setHeaders !== undefined) throw new EnvironmentRuleError("A stdio server has no URL or headers.");
    if (edit.command !== undefined) next.command = edit.command;
    if (edit.args !== undefined) next.args = edit.args;
    if (!next.command) throw new EnvironmentRuleError("A stdio server needs a command to run, on one line, e.g. npx.");
    for (const name of edit.removeEnv ?? []) delete next.env[name];
    Object.assign(next.env, edit.setEnv ?? {});
    if (Object.keys(next.env).length > MAX_VALUES) throw new EnvironmentRuleError(`A server takes up to ${MAX_VALUES} variables.`);
  } else {
    if (edit.command !== undefined || edit.args !== undefined || edit.setEnv !== undefined) {
      throw new EnvironmentRuleError("An http server has no command, arguments or variables.");
    }
    if (edit.url !== undefined) next.url = edit.url;
    if (!next.url) throw new EnvironmentRuleError("An http server needs its URL, http:// or https://.");
    for (const name of edit.removeHeaders ?? []) delete next.headers[name];
    Object.assign(next.headers, edit.setHeaders ?? {});
    if (Object.keys(next.headers).length > MAX_VALUES) throw new EnvironmentRuleError(`A server takes up to ${MAX_VALUES} headers.`);
  }
  return next;
}

/** A server as Claude Code's MCP config has it (the agent turns it into
 *  Codex's too: runtime-agent/internal/codex). */
export function claudeMcpServer(server: NewMcpServer): Record<string, unknown> {
  if (server.transport === "stdio") {
    return {
      type: "stdio",
      command: server.command,
      args: server.args,
      ...(Object.keys(server.env).length > 0 && { env: server.env }),
    };
  }
  return { type: "http", url: server.url, ...(Object.keys(server.headers).length > 0 && { headers: server.headers }) };
}

/**
 * The servers a session loads: its project's, then the user's own over them
 * (theirs win on a name both have). Outrunner's own are added after, over
 * both (lib/missions/setup.ts withMissionServer).
 */
export function withProjectServers(user: Record<string, unknown>, project: Record<string, unknown>): Record<string, unknown> {
  return { ...project, ...user };
}

/** Headers pasted as `Name: value` lines, as a request shows them; the
 *  lines that aren't one are said. */
export function parseHeaderLines(text: string): { headers: Record<string, string>; skipped: string[] } {
  const headers: Record<string, string> = {};
  const skipped: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([^:\s]+)\s*:\s*(.*)$/.exec(line);
    if (match && HEADER_NAME.test(match[1])) headers[match[1]] = match[2];
    else skipped.push(line);
  }
  return { headers, skipped };
}

/** Arguments given one a line: blank lines dropped, each kept as written. */
export function parseArgLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "");
}
