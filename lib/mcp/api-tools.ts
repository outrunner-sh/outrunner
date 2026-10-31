/**
 * The Outrunner API as MCP tools (app/api/mcp): each tool is a call of the
 * REST API's own operation (lib/api/workspaces.ts, lib/api/catalog.ts) with
 * the same key, rights and rate limits, so an agent driving Outrunner over
 * MCP and a script over REST go down one path.
 *
 * Another module adds tools here with registerApiMcpTool; one with its own
 * endpoint and context makes its own McpServer (lib/mcp/server.ts).
 */

import { listProjectsApi } from "@/lib/api/catalog";
import { takeLimit, type ApiContext } from "@/lib/api/handler";
import { createPreviewApi, deletePreviewApi, listPreviewsApi, updatePreviewApi } from "@/lib/api/previews";
import { createLearningApi, deleteLearningApi, listLearningsApi, updateLearningApi } from "@/lib/api/learnings";
import { CREATE_LIMIT } from "@/lib/api/rate-limit";
import { checkWebhookUrl, messageSent, webhookHooks } from "@/lib/api/webhooks.deps";
import {
  answerApi,
  approvePlanApi,
  changesApi,
  createWorkspace,
  getWorkspaceApi,
  lifecycleApi,
  listChatsApi,
  listWorkspaces,
  readConversationApi,
  secretsApi,
  sendMessageApi,
  switchModelApi,
  waitApi,
} from "@/lib/api/workspaces";
import { McpServer, toolResult, type McpTool, type McpToolResult } from "@/lib/mcp/server";

/** The context with the request an operation reads: its query and body. */
function asCall(
  context: ApiContext,
  { method = "GET", query = {}, body }: { method?: string; query?: Record<string, unknown>; body?: unknown },
): ApiContext {
  const url = new URL(context.request.url);
  url.search = "";
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const request = new Request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: context.request.signal,
  });
  return { ...context, request };
}

/** An operation's answer as a tool's: its JSON, or its error's sentence. */
async function answer(response: Response): Promise<McpToolResult> {
  if (response.status === 204) return toolResult({ result: "done" });
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) return toolResult(json ?? {});
  const error = (json?.error ?? {}) as { message?: string };
  return toolResult({ error: json?.error ?? { message: `Refused (${response.status}).` }, message: error.message }, true);
}

function id(args: Record<string, unknown>): string {
  return typeof args.workspace_id === "string" ? args.workspace_id : "";
}

const WORKSPACE_ID = { workspace_id: { type: "string", description: "The session's id." } };

const CHAT_ID = {
  chat_id: { type: "string", description: "One of the session's chats (list_chats); none is its main chat." },
};

export const API_TOOLS: McpTool<ApiContext>[] = [
  {
    name: "list_projects",
    description: "List the org's repositories you may start sessions on: their ids (project_id) and full names.",
    inputSchema: {
      type: "object",
      properties: { page: { type: "integer", minimum: 1 }, per_page: { type: "integer", minimum: 1, maximum: 100 } },
    },
    call: async (context, args) => answer(await listProjectsApi(asCall(context, { query: args }))),
  },
  {
    name: "create_workspace",
    description:
      "Start a cloud coding session (a workspace) on a repository with a prompt. It answers at once with status `preparing`; " +
      "the prompt is sent once its box is ready. Use wait_for_workspace to wait for the agent's reply.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "The repository's id (list_projects)." },
        environment_id: { type: "string", description: "Or a project that's a repository's own." },
        prompt: { type: "string", description: "What the session should do." },
        model: { type: "string" },
        provider: { type: "string" },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
        agent: { type: "string", enum: ["claude", "codex"] },
        plan_mode: { type: "boolean", description: "Reply with a plan and wait before changing anything." },
        size: { type: "string", enum: ["x-small", "small", "medium", "large"] },
        branch: { type: "string" },
        base_branch: { type: "string" },
        webhook_url: { type: "string", description: "An https URL told of its events, signed." },
      },
      required: ["prompt"],
    },
    async call(context, args) {
      const decision = takeLimit(context.caller, CREATE_LIMIT, "create");
      if (!decision.allowed) {
        return toolResult({ error: { code: "rate_limited", message: `Too many sessions started. Try again in ${decision.retryAfter}s.` } }, true);
      }
      return answer(
        await createWorkspace(asCall(context, { method: "POST", body: args }), webhookHooks(context), async (input) =>
          checkWebhookUrl(input.webhookUrl),
        ),
      );
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to a session, waking it first if it was paused or archived. Then wait_for_workspace with the after_event " +
      "this answers with, for its reply. If after_event is null, poll get_workspace until turn.state is working before you wait.",
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_ID,
        content: { type: "string", description: "The message." },
        mode: { type: "string", enum: ["build", "plan"], description: "plan: it replies with a plan and waits for approve_plan." },
        ...CHAT_ID,
      },
      required: ["workspace_id", "content"],
    },
    call: async (context, args) =>
      answer(
        await sendMessageApi(
          asCall(context, {
            method: "POST",
            body: {
              content: args.content,
              ...(args.mode !== undefined && { mode: args.mode }),
              ...(args.chat_id !== undefined && { chat_id: args.chat_id }),
            },
          }),
          id(args),
          messageSent,
        ),
      ),
  },
  {
    name: "read_conversation",
    description:
      "Read a session's conversation, newest last, a page at a time. Pass next_before_event back as before_event for the page before.",
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_ID,
        before_event: { type: "string", description: "An event id: the page before it." },
        per_page: { type: "integer", minimum: 1, maximum: 100 },
        ...CHAT_ID,
      },
      required: ["workspace_id"],
    },
    call: async (context, args) =>
      answer(
        await readConversationApi(
          asCall(context, { query: { before_event: args.before_event, per_page: args.per_page, chat_id: args.chat_id } }),
          id(args),
        ),
      ),
  },
  {
    name: "wait_for_workspace",
    description:
      "Wait until the session's turn is over (idle), it needs input, or its setup ends, up to timeout_seconds (600 at most). " +
      "Answers with the session, its turn and its last message; timed_out says whether it gave up.",
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_ID,
        after_event: { type: "string", description: "What send_message answered with: wait for the turn that message starts." },
        timeout_seconds: { type: "integer", minimum: 0, maximum: 600 },
        ...CHAT_ID,
      },
      required: ["workspace_id"],
    },
    call: async (context, args) =>
      answer(
        await waitApi(
          asCall(context, { query: { timeout: args.timeout_seconds, after_event: args.after_event, chat_id: args.chat_id } }),
          id(args),
        ),
      ),
  },
  {
    name: "list_chats",
    description:
      "List a session's chats, its main one first: each a conversation of its own in the session's worktree, " +
      "on its own coding agent. Pass a chat's id as chat_id to send_message, read_conversation or wait_for_workspace.",
    inputSchema: { type: "object", properties: WORKSPACE_ID, required: ["workspace_id"] },
    call: async (context, args) => answer(await listChatsApi(asCall(context, {}), id(args))),
  },
  {
    name: "list_workspaces",
    description: "List sessions in the org, newest first, by status, source (app, slack, automation, github, api), user (or `me`) and repository.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        source: { type: "string", enum: ["app", "slack", "automation", "github", "api"] },
        user_id: { type: "string" },
        project_id: { type: "string" },
        page: { type: "integer", minimum: 1 },
        per_page: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    call: async (context, args) => answer(await listWorkspaces(asCall(context, { query: args }))),
  },
  {
    name: "get_workspace",
    description: "Get a session: its status, repository, branch, and where its turn is (working, needs_input, idle).",
    inputSchema: { type: "object", properties: WORKSPACE_ID, required: ["workspace_id"] },
    call: async (context, args) => answer(await getWorkspaceApi(asCall(context, {}), id(args))),
  },
  {
    name: "answer_question",
    description:
      "Answer the question a session's agent is waiting on (get_workspace's turn.pending_input, type question): one answer per " +
      "question, in order, picking options by label or answering in your own words. Then wait_for_workspace.",
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_ID,
        answers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              selected: { type: "array", items: { type: "string" }, description: "The labels of the options picked." },
              other: { type: "string", description: "An answer in your own words." },
            },
          },
        },
        dismissed: { type: "boolean", description: "Decline to answer instead." },
        ...CHAT_ID,
      },
      required: ["workspace_id"],
    },
    call: async (context, args) =>
      answer(
        await answerApi(
          asCall(context, {
            method: "POST",
            body: {
              ...(args.answers !== undefined && { answers: args.answers }),
              ...(args.dismissed !== undefined && { dismissed: args.dismissed }),
              ...(args.chat_id !== undefined && { chat_id: args.chat_id }),
            },
          }),
          id(args),
        ),
      ),
  },
  {
    name: "provide_secrets",
    description:
      "Give a session's agent the secrets it asked for (turn.pending_input, type secrets: its keys), by name, or skip them. " +
      "The project keeps them for its next sessions; they are never answered back.",
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_ID,
        values: { type: "object", additionalProperties: { type: "string" }, description: "Each secret's name and value." },
        skipped: { type: "boolean", description: "Go on without them." },
        ...CHAT_ID,
      },
      required: ["workspace_id"],
    },
    call: async (context, args) =>
      answer(
        await secretsApi(
          asCall(context, {
            method: "POST",
            body: {
              ...(args.values !== undefined && { values: args.values }),
              ...(args.skipped !== undefined && { skipped: args.skipped }),
              ...(args.chat_id !== undefined && { chat_id: args.chat_id }),
            },
          }),
          id(args),
        ),
      ),
  },
  {
    name: "approve_plan",
    description: "Approve the plan a session's agent is waiting on, so it builds it. To change the plan instead, send_message.",
    inputSchema: { type: "object", properties: { ...WORKSPACE_ID, ...CHAT_ID }, required: ["workspace_id"] },
    call: async (context, args) =>
      answer(
        await approvePlanApi(
          asCall(context, { method: "POST", body: args.chat_id !== undefined ? { chat_id: args.chat_id } : {} }),
          id(args),
        ),
      ),
  },
  {
    name: "switch_model",
    description: "Switch a session to another offered model, or effort, carrying its conversation on.",
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_ID,
        model: { type: "string" },
        provider: { type: "string", description: "Where the model runs, when its id alone doesn't say." },
        effort: { type: "string" },
        ...CHAT_ID,
      },
      required: ["workspace_id"],
    },
    call: async (context, args) =>
      answer(
        await switchModelApi(
          asCall(context, {
            method: "POST",
            body: Object.fromEntries(
              (["model", "provider", "effort", "chat_id"] as const).filter((k) => args[k] !== undefined).map((k) => [k, args[k]]),
            ),
          }),
          id(args),
        ),
      ),
  },
  {
    name: "get_changes",
    description: "The files a session changed from its base branch; with path, that file's diff.",
    inputSchema: {
      type: "object",
      properties: { ...WORKSPACE_ID, path: { type: "string", description: "A changed file's path, for its diff." } },
      required: ["workspace_id"],
    },
    call: async (context, args) => answer(await changesApi(asCall(context, { query: { path: args.path } }), id(args))),
  },
  {
    name: "archive_workspace",
    description: "Archive a session: snapshot it and let its box go. send_message wakes it again.",
    inputSchema: { type: "object", properties: WORKSPACE_ID, required: ["workspace_id"] },
    call: async (context, args) => answer(await lifecycleApi(asCall(context, { method: "POST" }), id(args), "archive")),
  },
  {
    name: "list_previews",
    description: "List a session's previews: links to servers running on its box, each with its port, mode (login or public) and url.",
    inputSchema: { type: "object", properties: WORKSPACE_ID, required: ["workspace_id"] },
    call: async (context, args) => answer(await listPreviewsApi(asCall(context, {}), id(args))),
  },
  {
    name: "create_preview",
    description:
      "Make a preview of a port a server listens on in a session's box: a stable link on Outrunner's preview domain. " +
      "mode login (the default) lets in signed-in members of the org who can see the repository; public lets in anyone with the link. " +
      "A port that has one already answers with it, unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_ID,
        port: { type: "integer", minimum: 1024, maximum: 65535, description: "The port the server listens on." },
        label: { type: "string", maxLength: 80, description: "A short name, e.g. \"Web app\"." },
        mode: { type: "string", enum: ["login", "public"] },
      },
      required: ["workspace_id", "port"],
    },
    call: async (context, args) =>
      answer(
        await createPreviewApi(asCall(context, { method: "POST", body: { port: args.port, label: args.label, mode: args.mode } }), id(args)),
      ),
  },
  {
    name: "update_preview",
    description: "Rename a session's preview, or switch its mode between login and public.",
    inputSchema: {
      type: "object",
      properties: {
        ...WORKSPACE_ID,
        preview_id: { type: "string" },
        label: { type: "string", maxLength: 80 },
        mode: { type: "string", enum: ["login", "public"] },
      },
      required: ["workspace_id", "preview_id"],
    },
    call: async (context, args) =>
      answer(
        await updatePreviewApi(
          asCall(context, { method: "PATCH", body: { label: args.label, mode: args.mode } }),
          id(args),
          typeof args.preview_id === "string" ? args.preview_id : "",
        ),
      ),
  },
  {
    name: "delete_preview",
    description: "Delete a session's preview: its link stops working for everyone within seconds.",
    inputSchema: { type: "object", properties: { ...WORKSPACE_ID, preview_id: { type: "string" } }, required: ["workspace_id", "preview_id"] },
    call: async (context, args) =>
      answer(
        await deletePreviewApi(asCall(context, { method: "DELETE" }), id(args), typeof args.preview_id === "string" ? args.preview_id : ""),
      ),
  },
  {
    name: "list_learnings",
    description:
      "List learnings: short standing instructions every new session loads. scope org is the org's (its admins change them), " +
      "personal the key's maker's own; status suggested lists suggestions waiting to be accepted.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["org", "personal"] },
        status: { type: "string", enum: ["active", "suggested"] },
        page: { type: "integer", minimum: 1 },
        per_page: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    call: async (context, args) => answer(await listLearningsApi(asCall(context, { query: args }))),
  },
  {
    name: "create_learning",
    description:
      "Add a learning every new session loads: a one-line title and the instruction itself, one to three lines, as the user said it. " +
      "A member's learning for the org (or one with suggest true) waits for an admin to accept it.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["org", "personal"], description: "Whose it is; personal unless said." },
        title: { type: "string", maxLength: 120 },
        body: { type: "string", maxLength: 2000 },
        suggest: { type: "boolean", description: "File it as a suggestion for someone to accept." },
      },
      required: ["title", "body"],
    },
    call: async (context, args) => answer(await createLearningApi(asCall(context, { method: "POST", body: args }))),
  },
  {
    name: "update_learning",
    description: "Change a learning's title or body, or accept a suggestion with status active.",
    inputSchema: {
      type: "object",
      properties: {
        learning_id: { type: "string" },
        title: { type: "string", maxLength: 120 },
        body: { type: "string", maxLength: 2000 },
        status: { type: "string", enum: ["active"] },
      },
      required: ["learning_id"],
    },
    call: async (context, { learning_id, ...patch }) =>
      answer(await updateLearningApi(asCall(context, { method: "PATCH", body: patch }), typeof learning_id === "string" ? learning_id : "")),
  },
  {
    name: "delete_learning",
    description: "Delete a learning, or dismiss a suggested one.",
    inputSchema: { type: "object", properties: { learning_id: { type: "string" } }, required: ["learning_id"] },
    call: async (context, args) =>
      answer(await deleteLearningApi(asCall(context, { method: "DELETE" }), typeof args.learning_id === "string" ? args.learning_id : "")),
  },
];

/** The server app/api/mcp answers with. */
export const apiMcpServer = new McpServer<ApiContext>(
  {
    name: "outrunner",
    version: "1",
    instructions:
      "Outrunner runs coding agents (Claude Code, Codex) in cloud workspaces on the org's repositories. " +
      "list_projects to find a repository, create_workspace to start one with a prompt, wait_for_workspace for its reply, " +
      "send_message to follow up, read_conversation for what it did.",
  },
  API_TOOLS,
);

/** Add a tool to the Outrunner API's MCP server, as the key's maker. */
export function registerApiMcpTool(tool: McpTool<ApiContext>): void {
  apiMcpServer.register(tool);
}
