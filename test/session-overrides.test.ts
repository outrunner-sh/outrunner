import assert from "node:assert/strict";
import { test } from "node:test";

import { coversRepos, parseSessionOverrides, subagentModel, withScopedSecrets, withSessionEnvironment, withSessionServers } from "@/lib/session/session-overrides";

test("none of them is no overrides", () => {
  assert.equal(parseSessionOverrides({}), null);
  assert.equal(parseSessionOverrides({ env: {}, mcp_servers: [], subagents: [] }), null);
});

test("variables are checked as a project's are, and Outrunner's own names refused", () => {
  assert.deepEqual(parseSessionOverrides({ env: { STRIPE_KEY: "sk_test" } }), { env: { STRIPE_KEY: "sk_test" }, mcpServers: {}, subagents: {} });
  assert.match(parseSessionOverrides({ env: { PATH: "/x" } }) as string, /PATH can't be set/);
  assert.match(parseSessionOverrides({ env: { OUTRUNNER_TOKEN: "x" } }) as string, /can't be set/);
  assert.match(parseSessionOverrides({ env: { "1BAD": "x" } }) as string, /can't be set/);
  assert.match(parseSessionOverrides({ env: { EMPTY: "" } }) as string, /1 to 4096 bytes/);
  assert.match(parseSessionOverrides({ env: ["A=1"] }) as string, /`env` is an object/);
  const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`V${i}`, "x"]));
  assert.match(parseSessionOverrides({ env: many }) as string, /up to 50/);
});

test("MCP servers are Cursor's shapes, as Claude Code's config has them", () => {
  const read = parseSessionOverrides({
    mcp_servers: [
      { name: "linear", type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer t" } },
      { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "g" } },
      { name: "events", type: "sse", url: "https://sse.example/sse" },
    ],
  });
  assert.ok(read && typeof read !== "string");
  assert.deepEqual(read.mcpServers, {
    linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer t" } },
    github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "g" } },
    events: { type: "sse", url: "https://sse.example/sse" },
  });
  assert.match(parseSessionOverrides({ mcp_servers: [{ name: "outrunner-x", url: "https://a.example" }] }) as string, /kept for Outrunner/);
  assert.match(parseSessionOverrides({ mcp_servers: [{ name: "a", url: "https://a.example", auth: { clientId: "x" } }] }) as string, /OAuth/);
  assert.match(parseSessionOverrides({ mcp_servers: [{ name: "a", url: "https://a.example" }, { name: "a", url: "https://b.example" }] }) as string, /Two servers/);
  assert.match(parseSessionOverrides({ mcp_servers: [{ name: "a", type: "ws", url: "wss://a" }] }) as string, /http, sse or stdio/);
});

test("subagents are named for Claude Code, with a model family when one is named", () => {
  const read = parseSessionOverrides({
    subagents: [
      { name: "Reviewer", description: "Reviews diffs", prompt: "Review the diff.", model: "claude-4.5-sonnet" },
      { name: "planner", description: "Plans", prompt: "Plan it.", model: { id: "gpt-5" } },
    ],
  });
  assert.ok(read && typeof read !== "string");
  assert.deepEqual(read.subagents, {
    reviewer: { description: "Reviews diffs", prompt: "Review the diff.", model: "sonnet" },
    planner: { description: "Plans", prompt: "Plan it." },
  });
  assert.equal(subagentModel("inherit"), "inherit");
  assert.equal(subagentModel({ id: "claude-opus-4-5" }), "opus");
  assert.match(parseSessionOverrides({ subagents: [{ name: "explore", description: "d", prompt: "p" }] }) as string, /Claude Code's own/);
  assert.match(parseSessionOverrides({ subagents: [{ name: "has space", description: "d", prompt: "p" }] }) as string, /lowercase/);
  assert.match(parseSessionOverrides({ subagents: [{ name: "x", prompt: "p" }] }) as string, /description/);
});

test("the session's own go over its project's and its user's", () => {
  const own = { env: { A: "session", C: "3" }, mcpServers: { db: { type: "http", url: "https://session" } }, subagents: {} };
  const project = { env: { A: "project", B: "2" }, files: { ".env": "X=1" }, setup: "pnpm i", run: null, archive: null, instructions: "Use pnpm." };
  assert.deepEqual(withSessionEnvironment(project, own), { ...project, env: { A: "session", B: "2", C: "3" } });
  // A project with no setup of its own still gets the session's.
  assert.deepEqual(withSessionEnvironment(null, own).env, { A: "session", C: "3" });
  const user = { archive: null, items: [], settings: { theme: "dark" }, mcpServers: { db: { type: "http", url: "https://user" }, notes: { type: "http", url: "https://n" } } };
  assert.deepEqual(withSessionServers(user, own)?.mcpServers, { db: { type: "http", url: "https://session" }, notes: { type: "http", url: "https://n" } });
  assert.equal(withSessionServers(user, { ...own, mcpServers: {} }), user);
});

test("the org's secrets go under the project's variables, the user's own over them", () => {
  const project = { env: { A: "project", B: "project" }, files: {}, setup: null, run: null, archive: null, instructions: null };
  const layered = withScopedSecrets(project, { team: { A: "team", T: "team" }, personal: { B: "mine", P: "mine" } });
  assert.deepEqual(layered?.env, { A: "project", T: "team", B: "mine", P: "mine" });
  assert.equal(withScopedSecrets(project, { team: {}, personal: {} }), project);
  assert.deepEqual(withScopedSecrets(null, { team: { T: "1" }, personal: {} })?.env, { T: "1" });
});

test("a secret for some repositories is a session's when it works on one of them", () => {
  assert.equal(coversRepos([], ["acme/web"]), true);
  assert.equal(coversRepos(["Acme/Web"], ["acme/web", "acme/api"]), true);
  assert.equal(coversRepos(["https://github.com/acme/web.git"], ["acme/web"]), true);
  assert.equal(coversRepos(["acme/api"], ["acme/web"]), false);
});
