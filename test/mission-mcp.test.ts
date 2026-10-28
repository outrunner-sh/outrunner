import assert from "node:assert/strict";
import { test } from "node:test";

import { carriesMissionToken, missionMcpServerWith } from "@/lib/missions/server";
import { MISSION_TOOLS, type MissionToolDeps } from "@/lib/missions/tools";
import { hashMissionToken, isMissionToken, mintMissionToken, missionForToken, type MissionTokenStore } from "@/lib/missions/token";
import { readBearer } from "@/lib/http/bearer";
import type { Workspace } from "@/lib/runtime/types";

const session = (id: string, patch: Partial<Workspace>) => ({ id, ownerId: "alice", status: "ready", kind: "session", parentMissionId: null, ...patch }) as Workspace;
const sessions = [session("m1", { kind: "mission" }), session("m2", { kind: "mission" }), session("r1", { parentMissionId: "m1" }), session("r2", { parentMissionId: "m2" })];
const sent: string[] = [];
const deps = (): MissionToolDeps =>
  ({
    access: async () => null,
    environmentReady: async () => null,
    session: async (id: string) => sessions.find((s) => s.id === id) ?? null,
    runners: async (m: string) => sessions.filter((s) => s.parentMissionId === m),
    working: async () => false,
    send: async (r: Workspace, c: string) => {
      sent.push(`${r.id}: ${c}`);
      return true;
    },
    queued: async () => new Map(),
    pullRequests: async () => [],
    readNotes: async () => {
      throw new Error("database down");
    },
  }) as unknown as MissionToolDeps;

const server = missionMcpServerWith(deps);
const rpc = (method: string, params?: unknown, missionId = "m1") => server.handle({ jsonrpc: "2.0", id: 1, method, params }, { missionId });

test("the Mission's tools are served on the app's MCP server code", async () => {
  const listed = (await rpc("tools/list")) as { result: { tools: { name: string }[] } };
  assert.deepEqual(
    listed.result.tools.map((t) => t.name),
    MISSION_TOOLS.map((t) => t.name),
  );
  const init = (await rpc("initialize", { protocolVersion: "2025-03-26" })) as { result: { serverInfo: { name: string }; instructions: string } };
  assert.equal(init.result.serverInfo.name, "outrunner-mission");
  assert.match(init.result.instructions, /spawn_runner/);
});

test("a call reaches only its token's Mission's Runners", async () => {
  sent.length = 0;
  const other = (await rpc("tools/call", { name: "message_runner", arguments: { runner_id: "r2", message: "hi" } })) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  assert.equal(other.result.isError, true);
  assert.match(other.result.content[0].text, /no Runner with that id/);
  const own = (await rpc("tools/call", { name: "message_runner", arguments: { runner_id: "r2", message: "hi" } }, "m2")) as {
    result: { isError?: boolean };
  };
  assert.equal(own.result.isError, undefined);
  assert.deepEqual(sent, ["r2: hi"]);
});

test("a tool that fails answers as the tool's error, not the protocol's", async () => {
  const failed = (await rpc("tools/call", { name: "read_notes", arguments: {} })) as { result: { isError?: boolean } };
  assert.equal(failed.result.isError, true);
});

test("/api/mcp tells a Mission's token from an API key", () => {
  assert.equal(carriesMissionToken("Bearer orm_abc123"), true);
  assert.equal(carriesMissionToken("Bearer or_key_abc123"), false);
  assert.equal(carriesMissionToken("Bearer orm_"), false);
  assert.equal(carriesMissionToken(null), false);
  assert.equal(isMissionToken("orm_x"), true);
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
