/**
 * A project's MCP servers (20261103131000_environment_mcp_servers.sql), which
 * every session of the project loads beside the user's own
 * (lib/environments/mcp.ts has the rules).
 *
 * Each server's environment and headers are sealed together, {env, headers}
 * (lib/crypto/secret-box.ts), their names kept beside them for showing
 * without opening them: as a project's variables, write-only. Access is the
 * project's (lib/db/environments.ts): reading needs read, changing it write
 * (else EnvironmentAccessError). A change moves the project's setup on a
 * generation, so its ready boxes are made again. Service role only.
 */

import { open, seal } from "@/lib/crypto/secret-box";
import { bumpGeneration, EnvironmentAccessError, EnvironmentConflictError } from "@/lib/db/environments";
import { environmentLevel } from "@/lib/db/org-access";
import { EnvironmentRuleError } from "@/lib/environments/rules";
import {
  applyMcpEdit,
  claudeMcpServer,
  MAX_MCP_SERVERS,
  type McpSecrets,
  type McpServerEdit,
  type McpServerShape,
  type NewMcpServer,
} from "@/lib/environments/mcp";
import { type AccessLevel, allows } from "@/lib/orgs/access";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A project's server as its page shows it: everything but its secrets'
 *  values. */
export type EnvironmentMcpServer = McpServerShape & {
  id: string;
  envNames: string[];
  headerNames: string[];
  createdAt: string;
  updatedAt: string;
};

/** The project has a server by that name already. */
export class McpServerConflictError extends Error {}

const COLUMNS = "id, name, transport, command, args, url, env_names, header_names, created_at, updated_at";

type Row = {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  url: string | null;
  env_names: string[];
  header_names: string[];
  created_at: string;
  updated_at: string;
};

function serverOf(row: Row): EnvironmentMcpServer {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: row.args,
    url: row.url,
    envNames: row.env_names,
    headerNames: row.header_names,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The project's servers, or null when the user can't read it. None before
 *  the migration that adds them. */
export async function listEnvironmentMcpServers(
  userId: string,
  environmentId: string,
): Promise<{ access: AccessLevel; servers: EnvironmentMcpServer[] } | null> {
  const access = await environmentLevel(userId, environmentId);
  if (!access) return null;
  const { data, error } = await createSupabaseAdminClient()
    .from("environment_mcp_servers")
    .select(COLUMNS)
    .eq("environment_id", environmentId)
    .order("name", { ascending: true });
  if (error && probeStatus(error) === "missing") return { access, servers: [] };
  if (error) throw error;
  return { access, servers: (data as Row[]).map(serverOf) };
}

async function requireWrite(userId: string, environmentId: string): Promise<void> {
  if (!allows(await environmentLevel(userId, environmentId), "write")) throw new EnvironmentAccessError();
}

/** The columns a server is written as, its secrets sealed. */
function columnsOf(server: NewMcpServer) {
  const envNames = Object.keys(server.env).sort();
  const headerNames = Object.keys(server.headers).sort();
  const secrets: McpSecrets = { env: server.env, headers: server.headers };
  return {
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    env_names: envNames,
    header_names: headerNames,
    secrets_ciphertext: envNames.length + headerNames.length > 0 ? seal(JSON.stringify(secrets)) : null,
  };
}

function openSecrets(id: string, ciphertext: string | null): McpSecrets {
  if (!ciphertext) return { env: {}, headers: {} };
  try {
    const secrets = JSON.parse(open(ciphertext)) as Partial<McpSecrets>;
    return { env: secrets.env ?? {}, headers: secrets.headers ?? {} };
  } catch (cause) {
    console.error(`MCP server ${id}'s secrets can't be opened`, cause);
    throw new EnvironmentRuleError("This server's values can't be read any more. Delete it and add it again.");
  }
}

/** Add a server to the project (already checked by newMcpServer). Refused
 *  past MAX_MCP_SERVERS (by the database), and as a conflict for a name it
 *  has. */
export async function createEnvironmentMcpServer(
  userId: string,
  environmentId: string,
  server: NewMcpServer,
): Promise<EnvironmentMcpServer> {
  await requireWrite(userId, environmentId);
  const { data, error } = await createSupabaseAdminClient()
    .from("environment_mcp_servers")
    .insert({ environment_id: environmentId, created_by: userId, ...columnsOf(server) })
    .select(COLUMNS)
    .single();
  if (error?.code === "23505") throw new McpServerConflictError(`This project has a server named ${server.name} already.`);
  // The cap is the database's (environment_mcp_servers_limit), so two added
  // at once can't both slip under it.
  if (error?.code === "23514" && error.message.includes("at most")) {
    throw new EnvironmentRuleError(`A project holds at most ${MAX_MCP_SERVERS} MCP servers.`);
  }
  if (error) throw error;
  await bumpGeneration(userId, environmentId);
  return serverOf(data as Row);
}

/** How many times an edit is tried again after losing a race with another. */
const EDIT_TRIES = 3;

/** Change one of the project's servers; null when it has none by that id.
 *  Its secrets are one sealed value, read, changed and written back: the
 *  write lands only if the row is as it was read, else the edit is made
 *  again on what is there now (as editEnvironmentSecrets). */
export async function updateEnvironmentMcpServer(
  userId: string,
  environmentId: string,
  serverId: string,
  edit: McpServerEdit,
): Promise<EnvironmentMcpServer | null> {
  await requireWrite(userId, environmentId);
  const supabase = createSupabaseAdminClient();
  for (let attempt = 0; attempt < EDIT_TRIES; attempt++) {
    const { data: row, error } = await supabase
      .from("environment_mcp_servers")
      .select(`${COLUMNS}, secrets_ciphertext`)
      .eq("environment_id", environmentId)
      .eq("id", serverId)
      .maybeSingle();
    if (error) throw error;
    if (!row) return null;
    const current: NewMcpServer = {
      name: row.name,
      transport: row.transport,
      command: row.command,
      args: row.args,
      url: row.url,
      ...openSecrets(row.id, row.secrets_ciphertext),
    };
    const next = applyMcpEdit(current, edit);
    const { data: written, error: updateError } = await supabase
      .from("environment_mcp_servers")
      .update(columnsOf(next))
      .eq("id", serverId)
      .eq("updated_at", row.updated_at)
      .select(COLUMNS);
    if (updateError?.code === "23505") throw new McpServerConflictError(`This project has a server named ${next.name} already.`);
    if (updateError) throw updateError;
    if (written.length > 0) {
      await bumpGeneration(userId, environmentId);
      return serverOf(written[0] as Row);
    }
  }
  throw new EnvironmentConflictError();
}

/** Remove one of the project's servers; false when it has none by that id. */
export async function deleteEnvironmentMcpServer(userId: string, environmentId: string, serverId: string): Promise<boolean> {
  await requireWrite(userId, environmentId);
  const { data, error } = await createSupabaseAdminClient()
    .from("environment_mcp_servers")
    .delete()
    .eq("environment_id", environmentId)
    .eq("id", serverId)
    .select("id");
  if (error) throw error;
  if (data.length === 0) return false;
  await bumpGeneration(userId, environmentId);
  return true;
}

/** The project's servers as a session loads them, by name, as Claude
 *  Code's MCP config has them, their secrets opened. A server whose sealed
 *  values no longer open is left out, said in the log, rather than failing
 *  the session. None for a project the user can't read, or before the
 *  migration. */
export async function sessionMcpServers(userId: string, environmentId: string): Promise<Record<string, unknown>> {
  if (!(await environmentLevel(userId, environmentId))) return {};
  const { data, error } = await createSupabaseAdminClient()
    .from("environment_mcp_servers")
    .select(`${COLUMNS}, secrets_ciphertext`)
    .eq("environment_id", environmentId);
  if (error && probeStatus(error) === "missing") return {};
  if (error) throw error;
  const servers: Record<string, unknown> = {};
  for (const row of data) {
    try {
      const secrets = openSecrets(row.id, row.secrets_ciphertext);
      servers[row.name] = claudeMcpServer({ ...serverOf(row as Row), ...secrets });
    } catch {
      // Said by openSecrets; the session starts without this one.
    }
  }
  return servers;
}
