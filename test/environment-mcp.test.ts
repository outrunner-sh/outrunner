import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyMcpEdit,
  claudeMcpServer,
  mcpServerEdit,
  mcpServerName,
  newMcpServer,
  parseArgLines,
  parseHeaderLines,
  withProjectServers,
} from "@/lib/environments/mcp";
import { EnvironmentRuleError } from "@/lib/environments/rules";
import { MISSION_MCP_SERVER, withMissionServer } from "@/lib/missions/setup";

test("a server's name is one both agents take, and never one of Outrunner's own", () => {
  assert.equal(mcpServerName(" linear "), "linear");
  assert.equal(mcpServerName("my_db-2"), "my_db-2");
  for (const name of ["outrunner", "outrunner-mission", "Outrunner-desktop", "-x", "has space", "a.b", "", "x".repeat(65), 7]) {
    assert.throws(() => mcpServerName(name), EnvironmentRuleError, String(name));
  }
});

test("a stdio server is a command with its arguments and variables; an http one a URL with headers", () => {
  assert.deepEqual(
    newMcpServer({ name: "db", transport: "stdio", command: "npx", args: ["-y", "@acme/db"], env: { DATABASE_URL: "postgres://x" } }),
    { name: "db", transport: "stdio", command: "npx", args: ["-y", "@acme/db"], url: null, env: { DATABASE_URL: "postgres://x" }, headers: {} },
  );
  assert.deepEqual(
    newMcpServer({ name: "docs", transport: "http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer t" } }),
    { name: "docs", transport: "http", command: null, args: [], url: "https://mcp.example/mcp", env: {}, headers: { Authorization: "Bearer t" } },
  );
  for (const bad of [
    { name: "x", transport: "sse", url: "https://x" },
    { name: "x", transport: "stdio" },
    { name: "x", transport: "stdio", command: "npx\nrm -rf /" },
    { name: "x", transport: "stdio", command: "npx", url: "https://x" },
    { name: "x", transport: "stdio", command: "npx", env: { "BAD-NAME": "v" } },
    { name: "x", transport: "stdio", command: "npx", args: [1] },
    { name: "x", transport: "http", url: "ftp://x" },
    { name: "x", transport: "http", url: "not a url" },
    { name: "x", transport: "http", url: "https://x", command: "npx" },
    { name: "x", transport: "http", url: "https://x", headers: { Authorization: "a\r\nInjected: 1" } },
    { name: "outrunner-x", transport: "http", url: "https://x" },
  ]) {
    assert.throws(() => newMcpServer(bad), EnvironmentRuleError, JSON.stringify(bad));
  }
});

test("an edit sets and removes values by name, and a new transport starts from its own fields", () => {
  const db = newMcpServer({ name: "db", transport: "stdio", command: "npx", args: ["db"], env: { A: "1", B: "2" } });
  assert.deepEqual(applyMcpEdit(db, mcpServerEdit({ setEnv: { B: "3", C: "4" }, removeEnv: ["A"], args: ["db", "--ro"] })), {
    ...db,
    args: ["db", "--ro"],
    env: { B: "3", C: "4" },
  });
  // Unchanged, the server it was given.
  assert.deepEqual(db.env, { A: "1", B: "2" });

  const http = applyMcpEdit(db, mcpServerEdit({ transport: "http", url: "https://mcp.example", setHeaders: { "X-Key": "k" } }));
  assert.deepEqual(http, { name: "db", transport: "http", command: null, args: [], url: "https://mcp.example/", env: {}, headers: { "X-Key": "k" } });
  assert.throws(() => applyMcpEdit(db, mcpServerEdit({ transport: "http" })), EnvironmentRuleError, "http needs its URL");
  assert.throws(() => applyMcpEdit(http, mcpServerEdit({ setEnv: { A: "1" } })), EnvironmentRuleError, "http has no variables");
  assert.throws(() => mcpServerEdit({ secrets: {} }), EnvironmentRuleError);
  assert.throws(() => mcpServerEdit({ name: "outrunner-x" }), EnvironmentRuleError);
});

test("a server is given as Claude Code's MCP config has it", () => {
  assert.deepEqual(claudeMcpServer(newMcpServer({ name: "db", transport: "stdio", command: "npx", env: { K: "v" } })), {
    type: "stdio",
    command: "npx",
    args: [],
    env: { K: "v" },
  });
  assert.deepEqual(claudeMcpServer(newMcpServer({ name: "d", transport: "http", url: "https://mcp.example/mcp" })), {
    type: "http",
    url: "https://mcp.example/mcp",
  });
});

test("the user's own servers win over the project's, and Outrunner's over both", () => {
  const project = { linear: { type: "http", url: "https://project" }, db: { type: "stdio", command: "db" } };
  const user = { linear: { type: "http", url: "https://mine" } };
  const merged = withProjectServers(user, project);
  assert.deepEqual(merged, { linear: { type: "http", url: "https://mine" }, db: { type: "stdio", command: "db" } });

  // A Mission's server goes on last, whatever else has its name.
  const config = withMissionServer(
    { archive: null, items: [], settings: {}, mcpServers: { ...merged, [MISSION_MCP_SERVER]: { type: "http", url: "https://evil" } } },
    { token: "t", notes: "", url: "https://app.example/api/missions/mcp" },
  );
  assert.equal((config.mcpServers[MISSION_MCP_SERVER] as { url: string }).url, "https://app.example/api/missions/mcp");
  assert.deepEqual(config.mcpServers.linear, { type: "http", url: "https://mine" });
});

test("pasted headers and arguments are read a line each", () => {
  assert.deepEqual(parseHeaderLines("Authorization: Bearer a:b\n# a comment\n\nX-Key:k\nnot a header\n"), {
    headers: { Authorization: "Bearer a:b", "X-Key": "k" },
    skipped: ["not a header"],
  });
  assert.deepEqual(parseArgLines("-y\n\n@acme/mcp\n  --flag value \n"), ["-y", "@acme/mcp", "  --flag value "]);
});
