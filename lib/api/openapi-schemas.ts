/**
 * The bodies of the API's most used calls, as JSON Schema, for the OpenAPI
 * description (lib/api/openapi.ts): starting a session, reading it,
 * messaging it, and its runs. What the rest take and answer is in
 * docs/api.md. Held to the code by test/api-openapi.test.ts.
 */

import { API_STATUSES, API_SOURCES } from "@/lib/api/serialize";

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const text = { type: "string" };
const time = { type: "string", format: "date-time" };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** A run's status: `preparing` is a session's first, before its prompt is in its log. */
export const RUN_STATUSES = ["preparing", "running", "needs_input", "finished", "cancelled", "error"] as const;

export const SCHEMAS: Record<string, Record<string, unknown>> = {
  Image: {
    description: "An image for the agent to see: base64 `data` with its type (`mime_type`, or `mimeType`), or an https `url`.",
    oneOf: [
      {
        type: "object",
        properties: {
          data: { type: "string", description: "Base64, or a data: URL" },
          mime_type: { type: "string", enum: ["image/png", "image/jpeg", "image/gif", "image/webp"] },
          mimeType: { type: "string", description: "Taken for mime_type" },
        },
        required: ["data"],
      },
      { type: "object", properties: { url: { type: "string", format: "uri" } }, required: ["url"] },
    ],
  },
  McpServer: {
    type: "object",
    properties: {
      name: text,
      type: { type: "string", enum: ["http", "sse", "stdio"] },
      url: text,
      headers: { type: "object", additionalProperties: text },
      command: text,
      args: { type: "array", items: text },
      env: { type: "object", additionalProperties: text },
    },
    required: ["name"],
  },
  Subagent: {
    type: "object",
    properties: { name: text, description: text, prompt: text, model: text },
    required: ["name", "description", "prompt"],
  },
  WorkspaceCreate: {
    type: "object",
    description: "Name where it works: one of project_id, environment_id, repo_url (or pr_url).",
    properties: {
      prompt: { type: "string", description: "What to do; sent once the session is ready" },
      project_id: { type: "string", format: "uuid" },
      environment_id: { type: "string", format: "uuid" },
      repo_url: text,
      pr_url: text,
      name: { type: "string", maxLength: 120 },
      images: { type: "array", items: ref("Image") },
      attachment_ids: { type: "array", items: { type: "string", format: "uuid" } },
      model: text,
      provider: text,
      effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
      agent: { type: "string", enum: ["claude", "codex"] },
      plan_mode: { type: "boolean" },
      auto_create_pr: { type: "boolean" },
      work_on_current_branch: { type: "boolean" },
      size: { type: "string", enum: ["x-small", "small", "medium", "large"] },
      branch: text,
      base_branch: text,
      webhook_url: { type: "string", format: "uri" },
      env: { type: "object", additionalProperties: text, description: "Variables of its own, over its project's" },
      mcp_servers: { type: "array", items: ref("McpServer") },
      subagents: { type: "array", items: ref("Subagent") },
    },
    required: ["prompt"],
  },
  Workspace: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      title: nullable(text),
      status: { type: "string", enum: [...API_STATUSES] },
      setup_phase: nullable(text),
      org_id: nullable(text),
      user_id: text,
      project_id: text,
      environment_id: nullable(text),
      source: { type: "string", enum: [...API_SOURCES] },
      agent: text,
      model: nullable({ type: "object", properties: { provider: text, id: text, effort: nullable(text) } }),
      branch: text,
      base_branch: text,
      repositories: nullable({
        type: "array",
        items: { type: "object", properties: { project_id: text, full_name: text, folder: text, base_branch: text } },
      }),
      error_message: nullable(text),
      url: { type: "string", format: "uri" },
      created_at: time,
      updated_at: time,
      last_active_at: nullable(time),
    },
    required: ["id", "status", "url", "created_at"],
  },
  WorkspaceStarted: {
    allOf: [
      ref("Workspace"),
      {
        type: "object",
        properties: {
          run_id: { type: "string", const: "run-1", description: "Its first run, by its place: every run call takes it" },
          run: ref("Run"),
        },
        required: ["run_id"],
      },
    ],
  },
  Turn: {
    type: "object",
    properties: {
      state: { type: "string", enum: ["working", "needs_input", "idle"] },
      pending_input: nullable({ type: "object" }),
      last_message: nullable(text),
      last_event_id: nullable(text),
    },
  },
  WorkspaceWithTurn: {
    allOf: [ref("Workspace"), { type: "object", properties: { turn: nullable(ref("Turn")) } }],
  },
  WorkspacePage: {
    type: "object",
    properties: {
      data: { type: "array", items: ref("Workspace") },
      page: { type: "integer" },
      per_page: { type: "integer" },
      total: { type: "integer" },
      total_pages: { type: "integer" },
      has_more: { type: "boolean" },
    },
    required: ["data", "has_more"],
  },
  Message: {
    type: "object",
    description: "Words (`content`, or `prompt`), files, or both.",
    properties: {
      content: text,
      prompt: { anyOf: [text, { type: "object", properties: { text, images: { type: "array", items: ref("Image") } } }] },
      images: { type: "array", items: ref("Image") },
      attachment_ids: { type: "array", items: { type: "string", format: "uuid" } },
      mode: { type: "string", enum: ["build", "plan"] },
      chat_id: text,
    },
  },
  MessageSent: {
    type: "object",
    properties: {
      result: { type: "string", const: "sent" },
      workspace_id: text,
      chat_id: text,
      after_event: nullable(text),
      run_id: nullable({ type: "string", description: "The run it starts, once the box has logged it" }),
    },
    required: ["result", "workspace_id"],
  },
  Usage: {
    type: "object",
    properties: {
      input_tokens: { type: "integer" },
      output_tokens: { type: "integer" },
      cache_creation_input_tokens: { type: "integer" },
      cache_read_input_tokens: { type: "integer" },
      total_tokens: { type: "integer" },
    },
  },
  Run: {
    type: "object",
    properties: {
      id: { type: "string", description: "Its prompt's event id (`run-1` for a first run not begun); its place, `run-<number>`, is taken too" },
      number: { type: "integer", minimum: 1 },
      prompt: nullable(text),
      status: { type: "string", enum: [...RUN_STATUSES] },
      started_at: nullable(time),
      ended_at: nullable(time),
      duration_ms: nullable({ type: "integer" }),
      result: nullable(text),
      error: nullable(text),
      pending_input: nullable({ type: "object" }),
      usage: ref("Usage"),
      first_event: nullable(text),
      last_event: nullable(text),
      from: { type: "string", enum: ["live", "archive", "none"] },
    },
    required: ["id", "number", "status"],
  },
  RunPage: {
    type: "object",
    properties: {
      data: { type: "array", items: ref("Run") },
      page: { type: "integer" },
      per_page: { type: "integer" },
      total: { type: "integer" },
      total_pages: { type: "integer" },
      has_more: { type: "boolean" },
      from: { type: "string", enum: ["live", "archive", "none"] },
    },
    required: ["data", "has_more"],
  },
};

/** The calls described in full: their body's schema, and each answer's. */
export const OPERATION_SCHEMAS: Record<string, { request?: string; responses: Record<string, string> }> = {
  "POST /workspaces": { request: "WorkspaceCreate", responses: { "202": "WorkspaceStarted", "200": "WorkspaceStarted" } },
  "GET /workspaces": { responses: { "200": "WorkspacePage" } },
  "GET /workspaces/{id}": { responses: { "200": "WorkspaceWithTurn" } },
  "POST /workspaces/{id}/messages": { request: "Message", responses: { "202": "MessageSent" } },
  "GET /workspaces/{id}/runs": { responses: { "200": "RunPage" } },
  "GET /workspaces/{id}/runs/{runId}": { responses: { "200": "Run" } },
};
