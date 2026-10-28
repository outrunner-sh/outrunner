import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_BATCH, McpServer, PROTOCOL_VERSIONS, rpcResponse, toolCallCount, toolResult, type McpTool } from "@/lib/mcp/server";

type Context = { user: string };

const echo: McpTool<Context> = {
  name: "echo",
  description: "Say it back.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  call: async (context, args) => toolResult({ said: args.text, by: context.user }),
};

function server() {
  return new McpServer<Context>({ name: "test", version: "1", instructions: "Be brief." }, [echo]);
}

test("initialize answers with the version asked for, if it's one spoken", async () => {
  const answer = await server().handle(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "0" } } },
    { user: "u1" },
  );
  assert.deepEqual(answer, {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "test", version: "1" },
      instructions: "Be brief.",
    },
  });
  const other = (await server().handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, { user: "u1" })) as {
    result: { protocolVersion: string };
  };
  assert.equal(other.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test("tools are listed, and called with the route's context", async () => {
  const listed = (await server().handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { user: "u1" })) as {
    result: { tools: { name: string }[] };
  };
  assert.deepEqual(listed.result.tools.map((t) => t.name), ["echo"]);
  const called = (await server().handle(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } },
    { user: "u1" },
  )) as { result: { structuredContent: unknown; content: { text: string }[] } };
  assert.deepEqual(called.result.structuredContent, { said: "hi", by: "u1" });
  assert.match(called.result.content[0].text, /"said": "hi"/);
});

test("another module registers its tools on the same server; a name twice is refused", () => {
  const s = server();
  s.register({ ...echo, name: "shout" });
  assert.deepEqual(s.toolNames(), ["echo", "shout"]);
  assert.throws(() => s.register(echo), /registered twice/);
});

test("notifications get no answer, so the route says 202", async () => {
  const answer = await server().handle({ jsonrpc: "2.0", method: "notifications/initialized" }, { user: "u1" });
  assert.equal(answer, null);
  assert.equal(rpcResponse(answer).status, 202);
});

test("errors are the protocol's own", async () => {
  const s = server();
  const parse = (await s.handleText("{not json", { user: "u1" })) as { error: { code: number } };
  assert.equal(parse.error.code, -32700);
  const unknown = (await s.handle({ jsonrpc: "2.0", id: 3, method: "resources/list" }, { user: "u1" })) as { error: { code: number } };
  assert.equal(unknown.error.code, -32601);
  const noTool = (await s.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } }, { user: "u1" })) as {
    error: { code: number };
  };
  assert.equal(noTool.error.code, -32602);
  const invalid = (await s.handle({ id: 5, method: "ping" }, { user: "u1" })) as { error: { code: number } };
  assert.equal(invalid.error.code, -32600);
});

test("a batch is answered in one, notifications left out", async () => {
  const answer = (await server().handle(
    [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ],
    { user: "u1" },
  )) as { id: number }[];
  assert.deepEqual(answer.map((a) => a.id), [1, 2]);
});

test("a tool's failure is a result the model reads, flagged as an error", () => {
  assert.deepEqual(toolResult("No such session.", true), { content: [{ type: "text", text: "No such session." }], isError: true });
});

test("a batch is capped, and its tool calls counted for the rate limit", async () => {
  const ping = (id: number) => ({ jsonrpc: "2.0", id, method: "ping" });
  const big = (await server().handle(Array.from({ length: MAX_BATCH + 1 }, (_, i) => ping(i)), { user: "u1" })) as { error: { code: number } };
  assert.equal(big.error.code, -32600);
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "x" } } };
  assert.equal(toolCallCount([call, call, ping(3)]), 2);
  assert.equal(toolCallCount(call), 1);
  assert.equal(toolCallCount(null), 0);
});
