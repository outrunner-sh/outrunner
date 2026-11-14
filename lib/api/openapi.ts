/**
 * The public API's OpenAPI description (GET /api/v1/openapi.json), made from
 * one table of its operations. test/api-openapi.test.ts holds the table to
 * the routes under app/api/v1, so neither can gain an operation the other
 * lacks. What each takes and answers is in docs/api.md; the spec names every
 * operation, its parameters and whether it takes a body, for clients and
 * agents to find them by.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type ApiOperation = {
  method: HttpMethod;
  /** As under /api/v1, with `{param}`s. */
  path: string;
  summary: string;
  tag: string;
  /** Query parameters it reads. */
  query?: string[];
  /** It takes a JSON body (or multipart, for a file). */
  body?: "json" | "multipart";
  /** Only the org's admins may. */
  admin?: boolean;
  /** Only an org key may (it changes what runs on members' boxes). */
  orgKey?: boolean;
  /** No key needed. */
  open?: boolean;
};

const PAGE = ["page", "per_page"];

export const API_OPERATIONS: ApiOperation[] = [
  { method: "GET", path: "/openapi.json", summary: "This description of the API", tag: "API", open: true },
  { method: "GET", path: "/me", summary: "Who the key acts as, in which org, with what role", tag: "Account" },
  { method: "GET", path: "/members", summary: "The org's members and their roles", tag: "Org", query: PAGE },
  { method: "GET", path: "/usage", summary: "The org's cloud usage and its controls", tag: "Org" },

  { method: "GET", path: "/projects", summary: "The org's repositories the key's maker may start sessions on", tag: "Projects", query: PAGE },
  { method: "GET", path: "/environments", summary: "The org's projects", tag: "Projects", query: PAGE },
  { method: "GET", path: "/environments/{id}", summary: "A project in full", tag: "Projects" },
  { method: "PATCH", path: "/environments/{id}", summary: "Change a project's name, description, instructions, scripts or hooks (instructions, scripts and hooks: org keys only)", tag: "Projects", body: "json" },
  { method: "PATCH", path: "/environments/{id}/secrets", summary: "Set and remove a project's variables and files (write-only)", tag: "Projects", body: "json", orgKey: true },
  { method: "POST", path: "/environments/{id}/repos", summary: "Add a repository to a project", tag: "Projects", body: "json", orgKey: true },
  { method: "DELETE", path: "/environments/{id}/repos/{projectId}", summary: "Take a repository out of a project", tag: "Projects", orgKey: true },
  { method: "GET", path: "/environments/{id}/skills", summary: "The catalog skills enabled on a project", tag: "Skills", query: PAGE },
  { method: "POST", path: "/environments/{id}/skills", summary: "Enable a catalog skill", tag: "Skills", body: "json", orgKey: true },
  { method: "DELETE", path: "/environments/{id}/skills/{skillId}", summary: "Disable a skill", tag: "Skills", orgKey: true },
  { method: "GET", path: "/environments/{id}/skill-registries", summary: "A project's skill registries", tag: "Skills", query: PAGE },
  { method: "POST", path: "/environments/{id}/skill-registries", summary: "Add a GitHub repository as a skill registry", tag: "Skills", body: "json", orgKey: true },
  { method: "DELETE", path: "/environments/{id}/skill-registries/{registryId}", summary: "Remove a skill registry", tag: "Skills", orgKey: true },
  { method: "GET", path: "/environments/{id}/repo-skills", summary: "The skills, subagents and commands its repositories commit", tag: "Skills" },
  { method: "GET", path: "/skills/search", summary: "Search the skills.sh catalog", tag: "Skills", query: ["q"] },
  { method: "GET", path: "/environments/{id}/mcp-servers", summary: "A project's MCP servers", tag: "MCP servers", query: PAGE },
  { method: "POST", path: "/environments/{id}/mcp-servers", summary: "Add an MCP server to a project", tag: "MCP servers", body: "json", orgKey: true },
  { method: "PATCH", path: "/environments/{id}/mcp-servers/{serverId}", summary: "Change an MCP server", tag: "MCP servers", body: "json", orgKey: true },
  { method: "DELETE", path: "/environments/{id}/mcp-servers/{serverId}", summary: "Remove an MCP server", tag: "MCP servers", orgKey: true },

  { method: "POST", path: "/attachments", summary: "Upload a file to send with a prompt or a message", tag: "Sessions", body: "multipart" },
  { method: "GET", path: "/workspaces", summary: "Sessions, newest first", tag: "Sessions", query: ["status", "source", "user_id", "project_id", ...PAGE] },
  { method: "POST", path: "/workspaces", summary: "Start a session", tag: "Sessions", body: "json" },
  { method: "GET", path: "/workspaces/{id}", summary: "A session, and where its turn is", tag: "Sessions" },
  { method: "DELETE", path: "/workspaces/{id}", summary: "Delete a session for good", tag: "Sessions" },
  { method: "POST", path: "/workspaces/{id}/messages", summary: "Send a session a message, with files or in plan mode", tag: "Sessions", body: "json" },
  { method: "POST", path: "/workspaces/{id}/answer", summary: "Answer the question the agent is waiting on", tag: "Sessions", body: "json" },
  { method: "POST", path: "/workspaces/{id}/secrets", summary: "Give the agent the secrets it asked for", tag: "Sessions", body: "json" },
  { method: "POST", path: "/workspaces/{id}/plan/approve", summary: "Approve the plan the agent is waiting on", tag: "Sessions", body: "json" },
  { method: "POST", path: "/workspaces/{id}/model", summary: "Switch the session's model or effort", tag: "Sessions", body: "json" },
  { method: "POST", path: "/workspaces/{id}/interrupt", summary: "Stop the turn it's running", tag: "Sessions", body: "json" },
  { method: "GET", path: "/workspaces/{id}/conversation", summary: "Its conversation, a page at a time going back", tag: "Sessions", query: ["before_event", "per_page", "chat_id"] },
  { method: "GET", path: "/workspaces/{id}/wait", summary: "Hold the call until its turn is over or it needs input", tag: "Sessions", query: ["after_event", "timeout", "chat_id"] },
  { method: "GET", path: "/workspaces/{id}/chats", summary: "Its chats, its main one first", tag: "Sessions" },
  { method: "GET", path: "/workspaces/{id}/changes", summary: "The files it changed, or one file's diff", tag: "Sessions", query: ["path"] },
  { method: "POST", path: "/workspaces/{id}/suspend", summary: "Pause its box", tag: "Sessions" },
  { method: "POST", path: "/workspaces/{id}/resume", summary: "Wake it, or restore it if archived", tag: "Sessions" },
  { method: "POST", path: "/workspaces/{id}/archive", summary: "Snapshot it and let its box go", tag: "Sessions" },
  { method: "GET", path: "/workspaces/{id}/pull-requests", summary: "Its pull request in each of its repositories", tag: "Sessions" },
  { method: "GET", path: "/workspaces/{id}/previews", summary: "Its preview links", tag: "Previews" },
  { method: "POST", path: "/workspaces/{id}/previews", summary: "Share one of its servers as a preview link", tag: "Previews", body: "json" },
  { method: "PATCH", path: "/workspaces/{id}/previews/{previewId}", summary: "Change a preview link", tag: "Previews", body: "json" },
  { method: "DELETE", path: "/workspaces/{id}/previews/{previewId}", summary: "Take a preview link down", tag: "Previews" },

  { method: "GET", path: "/automations", summary: "The org's automations", tag: "Automations", query: PAGE },
  { method: "POST", path: "/automations", summary: "Make an automation", tag: "Automations", body: "json", admin: true },
  { method: "GET", path: "/automations/runs", summary: "The org's 50 most recent automation runs", tag: "Automations", query: ["automation_id", ...PAGE] },
  { method: "GET", path: "/automations/{id}", summary: "One automation", tag: "Automations" },
  { method: "PATCH", path: "/automations/{id}", summary: "Change an automation", tag: "Automations", body: "json", admin: true },
  { method: "DELETE", path: "/automations/{id}", summary: "Delete an automation", tag: "Automations", admin: true },

  { method: "GET", path: "/triage/items", summary: "The org's work items", tag: "Triage", query: ["status", "project_id", ...PAGE] },
  { method: "POST", path: "/triage/items", summary: "File a work item", tag: "Triage", body: "json" },
  { method: "GET", path: "/triage/items/{id}", summary: "One work item", tag: "Triage" },

  { method: "GET", path: "/learnings", summary: "Standing instructions sessions load", tag: "Learnings", query: PAGE },
  { method: "POST", path: "/learnings", summary: "Add a learning", tag: "Learnings", body: "json" },
  { method: "GET", path: "/learnings/{id}", summary: "One learning", tag: "Learnings" },
  { method: "PATCH", path: "/learnings/{id}", summary: "Change a learning", tag: "Learnings", body: "json" },
  { method: "DELETE", path: "/learnings/{id}", summary: "Remove a learning", tag: "Learnings" },
];

/** An operation's id: its method and path, as a client names a call. */
export function operationId({ method, path }: ApiOperation): string {
  const words = path
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[{}.]/g, "").replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase()));
  return [method.toLowerCase(), ...words.map((w) => w[0].toUpperCase() + w.slice(1))].join("");
}

const ERROR_RESPONSE = { description: "An error: `error.code` and `error.message`", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };

/** The OpenAPI 3.1 document, with `base` as the server's address. */
export function openApiSpec(base: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of API_OPERATIONS) {
    const params = [...op.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({ name, in: "path", required: true, schema: { type: "string" } }));
    const query = (op.query ?? []).map((name) => ({ name, in: "query", required: false, schema: { type: "string" } }));
    paths[op.path] ??= {};
    paths[op.path][op.method.toLowerCase()] = {
      operationId: operationId(op),
      summary: op.summary,
      tags: [op.tag],
      ...((op.admin || op.orgKey) && {
        description: op.orgKey ? "Only an org key may: it changes what runs on members' boxes." : "Only the org's admins may.",
      }),
      ...(op.open && { security: [] }),
      ...((params.length || query.length) && { parameters: [...params, ...query] }),
      ...(op.body && {
        requestBody: {
          required: true,
          content:
            op.body === "multipart"
              ? { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] } } }
              : { "application/json": { schema: { type: "object" } } },
        },
      }),
      responses: {
        "2XX": { description: "Done: see docs/api.md for its shape", content: { "application/json": { schema: { type: "object" } } } },
        "4XX": ERROR_RESPONSE,
        "5XX": ERROR_RESPONSE,
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Outrunner API",
      version: "1",
      description: "Start and drive coding sessions, and manage the projects and automations they run on. Each call acts as the key's maker.",
    },
    servers: [{ url: `${base.replace(/\/$/, "")}/api/v1` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "An org or personal API key (or the CLI's token)" } },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  enum: ["invalid_request", "unauthorized", "forbidden", "not_found", "conflict", "rate_limited", "upstream_unavailable", "internal"],
                },
                message: { type: "string" },
                status: { type: "integer" },
                settings_url: { type: "string" },
              },
              required: ["code", "message", "status"],
            },
          },
          required: ["error"],
        },
      },
    },
    paths,
  };
}
