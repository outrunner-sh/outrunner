import assert from "node:assert/strict";
import { test } from "node:test";

import { handleMcpBody, handleMcpMessage, type McpServer } from "@/lib/missions/mcp";
import { hashMissionToken, mintMissionToken, missionForToken, type MissionTokenStore } from "@/lib/missions/token";
import { readBearer } from "@/lib/http/bearer";

const server: McpServer = {
  name: "outrunner-mission",
  version: "1",
  instructions: "Runner tools.",
  tools: [{ name: "echo", description: "Echo.", inputSchema: { type: "object" } }],
  call: async (name, args) => (args.fail ? Promise.reject(new Error("boom")) : { text: `${name}:${JSON.stringify(args)}` }),
};

test("initialize names the server and agrees a protocol version", async () => {
  const answer = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {} } },
    server,
  );
  assert.deepEqual(answer, {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "outrunner-mission", version: "1" },
      instructions: "Runner tools.",
    },
  });
  const newer = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } }, server);
  assert.equal((newer?.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
});

test("tools are listed and called; a failure is the tool's error, not the transport's", async () => {
  const list = await handleMcpMessage({ jsonrpc: "2.0", id: "a", method: "tools/list" }, server);
  assert.equal((list?.result as { tools: unknown[] }).tools.length, 1);
  const call = await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { x: 1 } } }, server);
  assert.deepEqual(call?.result, { content: [{ type: "text", text: 'echo:{"x":1}' }] });
  const failed = await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { fail: true } } }, server);
  assert.equal((failed?.result as { isError: boolean }).isError, true);
  const unknown = await handleMcpMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } }, server);
  assert.equal(unknown?.error?.code, -32602);
});

test("notifications get no answer; a batch gets one per request", async () => {
  assert.equal(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, server), null);
  assert.equal(await handleMcpBody({ jsonrpc: "2.0", method: "notifications/initialized" }, server), null);
  const batch = await handleMcpBody(
    [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "resources/list" },
    ],
    server,
  );
  assert.deepEqual(batch, [
    { jsonrpc: "2.0", id: 1, result: {} },
    { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found: resources/list" } },
  ]);
  assert.equal((await handleMcpMessage("junk", server))?.error?.code, -32600);
});

function memoryTokens(): MissionTokenStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    save: async (missionId, hash) => {
      rows.set(missionId, hash);
    },
    find: async (hash) => [...rows].find(([, h]) => h === hash)?.[0] ?? null,
  };
}

test("a Mission's token names that Mission, and a new one retires the last", async () => {
  const store = memoryTokens();
  const first = await mintMissionToken("m1", store);
  const other = await mintMissionToken("m2", store);
  assert.equal(await missionForToken(first, store), "m1");
  assert.equal(await missionForToken(other, store), "m2");
  // Only the hash is kept.
  assert.equal(store.rows.get("m1"), hashMissionToken(first));
  assert.ok(![...store.rows.values()].includes(first));

  const second = await mintMissionToken("m1", store);
  assert.equal(await missionForToken(first, store), null);
  assert.equal(await missionForToken(second, store), "m1");
});

test("anything that isn't a Mission's token names no Mission", async () => {
  const store = memoryTokens();
  await mintMissionToken("m1", store);
  for (const token of [null, undefined, "", "orm_", "orm_nope", "sk-ant-123", "x".repeat(500)]) {
    assert.equal(await missionForToken(token, store), null, String(token));
  }
});

test("the bearer is read from Authorization alone", () => {
  assert.equal(readBearer("Bearer orm_abc"), "orm_abc");
  assert.equal(readBearer("bearer  orm_abc "), "orm_abc");
  assert.equal(readBearer("Basic abc"), null);
  assert.equal(readBearer(null), null);
});
