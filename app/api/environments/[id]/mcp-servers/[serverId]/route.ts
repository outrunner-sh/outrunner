import { after, NextResponse } from "next/server";

import { EnvironmentAccessError, EnvironmentConflictError } from "@/lib/db/environments";
import {
  deleteEnvironmentMcpServer,
  McpServerConflictError,
  updateEnvironmentMcpServer,
} from "@/lib/db/environment-mcp";
import { mcpServerEdit } from "@/lib/environments/mcp";
import { EnvironmentRuleError } from "@/lib/environments/rules";
import { environmentRequest } from "@/lib/http/environment-request";
import { savingSettings } from "@/lib/http/settings-save";
import { refillAfterChange } from "@/lib/runtime/warm-pool.deps";

type RouteContext = { params: Promise<{ id: string; serverId: string }> };

/**
 * One of a project's MCP servers. PATCH changes what it's given: `name`,
 * `transport` (with the new one's `command` or `url`), `command`, `args`,
 * `url`; `setEnv`/`removeEnv` and `setHeaders`/`removeHeaders` set and
 * remove values by name, as the project's variables are edited. DELETE
 * removes it. New sessions get the change.
 */

function gone() {
  return NextResponse.json({ error: "That isn't one of this project's MCP servers." }, { status: 404 });
}

export async function PATCH(request: Request, context: RouteContext) {
  const c = await environmentRequest(request, context.params, { write: true, ids: ["id", "serverId"] });
  if ("response" in c) return c.response;
  const { id, serverId } = c.params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "That isn't a change a server takes." }, { status: 400 });
  }
  return savingSettings("project MCP servers", async () => {
    try {
      const server = await updateEnvironmentMcpServer(c.owner.id, id, serverId, mcpServerEdit(body));
      if (!server) return gone();
      after(() => refillAfterChange(c.owner.id, id));
      return NextResponse.json({ server });
    } catch (error) {
      if (error instanceof EnvironmentRuleError) return NextResponse.json({ error: error.message }, { status: 400 });
      if (error instanceof McpServerConflictError || error instanceof EnvironmentConflictError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (error instanceof EnvironmentAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  const c = await environmentRequest(request, context.params, { write: true, ids: ["id", "serverId"] });
  if ("response" in c) return c.response;
  const { id, serverId } = c.params;
  return savingSettings("project MCP servers", async () => {
    try {
      if (!(await deleteEnvironmentMcpServer(c.owner.id, id, serverId))) return gone();
    } catch (error) {
      if (error instanceof EnvironmentAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
    after(() => refillAfterChange(c.owner.id, id));
    return NextResponse.json({ ok: true });
  });
}
