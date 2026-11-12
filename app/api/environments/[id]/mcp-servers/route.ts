import { NextResponse } from "next/server";

import { after } from "@/lib/observability/after";

import { EnvironmentAccessError } from "@/lib/db/environments";
import { createEnvironmentMcpServer, listEnvironmentMcpServers, McpServerConflictError } from "@/lib/db/environment-mcp";
import { newMcpServer } from "@/lib/environments/mcp";
import { EnvironmentRuleError } from "@/lib/environments/rules";
import { environmentRequest, projectNotFound } from "@/lib/http/environment-request";
import { savingSettings } from "@/lib/http/settings-save";
import { refillAfterChange } from "@/lib/runtime/warm-pool.deps";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A project's MCP servers, which every new session of it loads beside the
 * user's own. GET lists them with their variables' and headers' names,
 * never a value; POST adds one: `{name, transport: "stdio", command, args,
 * env}` or `{name, transport: "http", url, headers}`. A value is never
 * logged, and never read back.
 */

export async function GET(request: Request, context: RouteContext) {
  const c = await environmentRequest(request, context.params);
  if ("response" in c) return c.response;
  const listed = await listEnvironmentMcpServers(c.owner.id, c.params.id);
  if (!listed) return projectNotFound();
  return NextResponse.json({ servers: listed.servers });
}

export async function POST(request: Request, context: RouteContext) {
  const c = await environmentRequest(request, context.params, { write: true });
  if ("response" in c) return c.response;
  const { id } = c.params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  return savingSettings("project MCP servers", async () => {
    if (!(await listEnvironmentMcpServers(c.owner.id, id))) return projectNotFound();
    try {
      const server = await createEnvironmentMcpServer(c.owner.id, id, newMcpServer(body ?? {}));
      // Ready boxes were made without it: made again.
      after(() => refillAfterChange(c.owner.id, id), { where: "refill-pool", userId: c.owner.id });
      return NextResponse.json({ server }, { status: 201 });
    } catch (error) {
      if (error instanceof EnvironmentRuleError) return NextResponse.json({ error: error.message }, { status: 400 });
      if (error instanceof McpServerConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
      if (error instanceof EnvironmentAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
  });
}
