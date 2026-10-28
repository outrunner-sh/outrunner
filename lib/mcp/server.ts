/**
 * A Model Context Protocol server over streamable HTTP, as small as the
 * spec allows: each POST carries a JSON-RPC message (or a batch), and is
 * answered with JSON, never an SSE stream. Tools only: `initialize`,
 * `ping`, `tools/list` and `tools/call`. No network or auth here: a route
 * signs the call in and hands its context to every tool (app/api/mcp).
 *
 * The server is generic over that context, and its tools are a registry,
 * so another endpoint can serve its own tools on the same code (another
 * module's MCP endpoint, with its own context), and a module can add tools
 * to an existing server by registering them.
 */

/** The protocol versions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type JsonSchema = { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };

export type McpToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type McpTool<C> = {
  name: string;
  /** What the model reads to decide when to call it. */
  description: string;
  inputSchema: JsonSchema;
  call(context: C, args: Record<string, unknown>): Promise<McpToolResult>;
};

/** A tool's answer as text and, where it's an object, as structured content. */
export function toolResult(value: unknown, isError = false): McpToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const result: McpToolResult = { content: [{ type: "text", text }] };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    result.structuredContent = value as Record<string, unknown>;
  }
  if (isError) result.isError = true;
  return result;
}

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: unknown };
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function failure(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export class McpServer<C> {
  private readonly tools = new Map<string, McpTool<C>>();
  private readonly info: { name: string; version: string; instructions?: string };

  constructor(info: { name: string; version: string; instructions?: string }, tools: readonly McpTool<C>[] = []) {
    this.info = info;
    for (const tool of tools) this.register(tool);
  }

  /** Add a tool; a name already taken is a mistake, said at once. */
  register(tool: McpTool<C>): this {
    if (this.tools.has(tool.name)) throw new Error(`MCP tool ${tool.name} is registered twice`);
    this.tools.set(tool.name, tool);
    return this;
  }

  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Answer a POST's body: the responses to send back (one, or a batch's),
   * or null when it held only notifications (answered 202, no body).
   */
  async handle(body: unknown, context: C): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(body)) {
      if (body.length === 0) return failure(null, INVALID_REQUEST, "An empty batch.");
      const answers = (await Promise.all(body.map((message) => this.one(message, context)))).filter(
        (a): a is JsonRpcResponse => a !== null,
      );
      return answers.length ? answers : null;
    }
    return this.one(body, context);
  }

  /** Answer the raw text of a POST: a parse failure is the protocol's own error. */
  async handleText(text: string, context: C): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return failure(null, PARSE_ERROR, "The body isn't JSON.");
    }
    return this.handle(body, context);
  }

  private async one(message: unknown, context: C): Promise<JsonRpcResponse | null> {
    if (!message || typeof message !== "object" || (message as JsonRpcRequest).jsonrpc !== "2.0") {
      return failure(null, INVALID_REQUEST, "Not a JSON-RPC 2.0 message.");
    }
    const { id, method, params } = message as JsonRpcRequest;
    // A response the client sends (to a request this server never makes),
    // or a notification: nothing to answer.
    if (typeof method !== "string") return null;
    if (id === undefined) return null;
    try {
      return { jsonrpc: "2.0", id, result: await this.dispatch(method, params, context) };
    } catch (error) {
      if (error instanceof RpcError) return failure(id, error.code, error.message);
      console.error(`MCP ${method} failed`, error);
      return failure(id, INTERNAL_ERROR, "The server couldn't answer that.");
    }
  }

  private async dispatch(method: string, params: unknown, context: C): Promise<unknown> {
    const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
    switch (method) {
      case "initialize": {
        const asked = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
        const version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.info.name, version: this.info.version },
          ...(this.info.instructions && { instructions: this.info.instructions }),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        };
      case "tools/call": {
        const tool = typeof p.name === "string" ? this.tools.get(p.name) : undefined;
        if (!tool) throw new RpcError(INVALID_PARAMS, `No tool named ${String(p.name)}.`);
        const args = p.arguments && typeof p.arguments === "object" && !Array.isArray(p.arguments) ? p.arguments : {};
        return tool.call(context, args as Record<string, unknown>);
      }
      default:
        throw new RpcError(METHOD_NOT_FOUND, `This server doesn't do ${method}.`);
    }
  }
}

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** How a route answers what handle() returned. */
export function rpcResponse(answer: JsonRpcResponse | JsonRpcResponse[] | null): Response {
  if (answer === null) return new Response(null, { status: 202 });
  return Response.json(answer);
}
