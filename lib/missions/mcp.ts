/**
 * A small MCP server over Streamable HTTP, stateless: each POST carries one
 * JSON-RPC message (or a batch) and is answered with JSON, never a stream,
 * which the transport allows. Enough for tools: initialize, ping, tools/list
 * and tools/call. The Mission's endpoint (app/api/missions/mcp) serves its
 * tools through it; it knows nothing of Missions itself.
 */

import type { ToolDefinition, ToolResult } from "@/lib/missions/tools";

/** The protocol versions it speaks, newest first. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type McpServer = {
  name: string;
  version: string;
  /** Said to the client as it connects; Claude Code shows it to the model. */
  instructions?: string;
  tools: ToolDefinition[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
};

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

function failure(id: JsonRpcResponse["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** One message's answer; null for a notification, which has none. */
export async function handleMcpMessage(message: unknown, server: McpServer): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) return failure(null, -32600, "Invalid request");
  const { jsonrpc, id, method, params } = message as Message;
  const rpcId = typeof id === "string" || typeof id === "number" ? id : null;
  if (jsonrpc !== "2.0" || typeof method !== "string") return failure(rpcId, -32600, "Invalid request");
  // A notification (no id), or an answer to a request we never make.
  if (id === undefined) return null;
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  switch (method) {
    case "initialize": {
      const asked = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
      return {
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          protocolVersion: (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: server.name, version: server.version },
          ...(server.instructions && { instructions: server.instructions }),
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id: rpcId, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id: rpcId, result: { tools: server.tools } };
    case "tools/call": {
      const name = typeof p.name === "string" ? p.name : "";
      if (!server.tools.some((t) => t.name === name)) return failure(rpcId, -32602, `Unknown tool: ${name}`);
      const args = p.arguments && typeof p.arguments === "object" && !Array.isArray(p.arguments) ? (p.arguments as Record<string, unknown>) : {};
      let result: ToolResult;
      try {
        result = await server.call(name, args);
      } catch (error) {
        console.error(`MCP ${server.name}: ${name} failed`, error);
        result = { text: "That failed on Outrunner's side, and it logged why. Try again shortly.", isError: true };
      }
      return {
        jsonrpc: "2.0",
        id: rpcId,
        result: { content: [{ type: "text", text: result.text }], ...(result.isError && { isError: true }) },
      };
    }
    default:
      return failure(rpcId, -32601, `Method not found: ${method}`);
  }
}

/** A POST's body answered: one response, a batch of them, or none (202). */
export async function handleMcpBody(body: unknown, server: McpServer): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map((m) => handleMcpMessage(m, server)))).filter((a) => a !== null);
    return answers.length ? answers : null;
  }
  return handleMcpMessage(body, server);
}
