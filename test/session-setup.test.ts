import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentConfig } from "@/lib/db/agent-config";
import type { SetSkillsResponse } from "@/lib/runtime/agent-protocol";
import { deliverSessionSetup } from "@/lib/runtime/session-setup";

function box(features: string[], skills: SetSkillsResponse = { installed: [] }) {
  const sent: Array<[string, unknown]> = [];
  return {
    sent,
    client: {
      features: async () => features,
      setEnvironment: async (req: unknown) => void sent.push(["environment", req]),
      setAgentConfig: async (req: unknown) => void sent.push(["config", req]),
      setSkills: async (req: unknown) => {
        sent.push(["skills", req]);
        return skills;
      },
    },
  };
}

const environment = {
  env: { API_TOKEN: "tok" },
  files: { "api/.env": "DATABASE_URL=x\n" },
  setup: "pnpm install",
  run: null,
  archive: null,
  instructions: null,
};
const sha = `sha256:${"5".repeat(64)}`;
const agentConfig: AgentConfig = {
  archive: { path: "archives/u/agent-config/a.tar.gz", sha256: sha, size: 10 },
  items: ["claude-md"],
  mcpServers: { tracker: { type: "http", url: "https://mcp.example" } },
  settings: {},
};
const all = ["session-environment", "agent-config"];
const downloadUrl = async (path: string) => `https://storage/${path}`;

test("the user's setup and the project's environment reach a box that takes them", async () => {
  const b = box(all);
  await deliverSessionSetup(b.client, { environment, agentConfig, downloadUrl });
  assert.deepEqual(b.sent, [
    [
      "config",
      {
        version: sha,
        url: "https://storage/archives/u/agent-config/a.tar.gz",
        sha256: sha,
        mcpServers: { tracker: { type: "http", url: "https://mcp.example" } },
        settings: {},
      },
    ],
    ["environment", { env: { API_TOKEN: "tok" }, files: { "api/.env": "DATABASE_URL=x\n" }, setup: "pnpm install" }],
  ]);
});

test("nothing is sent for none, and what an old box can't take is skipped", async () => {
  const empty = box(all);
  await deliverSessionSetup(empty.client, {
    environment: { env: {}, files: {}, setup: null, run: null, archive: null, instructions: null },
    agentConfig: { archive: null, items: [], mcpServers: {}, settings: {} },
    downloadUrl,
  });
  assert.deepEqual(empty.sent, []);

  const old = box(["session-environment"]);
  await deliverSessionSetup(old.client, { environment, agentConfig, downloadUrl });
  assert.deepEqual(old.sent.map(([kind]) => kind), ["environment"]);
});

test("a project's instructions go only to a box that reads them", async () => {
  const withInstructions = { ...environment, instructions: "Use pnpm." };
  const current = box([...all, "project-instructions"]);
  await deliverSessionSetup(current.client, { environment: withInstructions, agentConfig: null, downloadUrl });
  assert.deepEqual(current.sent, [
    [
      "environment",
      { env: { API_TOKEN: "tok" }, files: { "api/.env": "DATABASE_URL=x\n" }, setup: "pnpm install", instructions: "Use pnpm." },
    ],
  ]);

  // An older one still gets the rest; instructions alone send nothing to it.
  const old = box(all);
  await deliverSessionSetup(old.client, { environment: withInstructions, agentConfig: null, downloadUrl });
  assert.equal((old.sent[0][1] as { instructions?: string }).instructions, undefined);
  const onlyInstructions = box(all);
  await deliverSessionSetup(onlyInstructions.client, {
    environment: { env: {}, files: {}, setup: null, run: null, archive: null, instructions: "Use pnpm." },
    agentConfig: null,
    downloadUrl,
  });
  assert.deepEqual(onlyInstructions.sent, []);
});

test("a project's hooks go only to a box that runs them", async () => {
  const withHooks = { ...environment, hooks: { warm: "pnpm install", start: "docker compose up -d" } };
  const current = box([...all, "warm-hooks"]);
  await deliverSessionSetup(current.client, { environment: withHooks, agentConfig: null, downloadUrl });
  const sent = current.sent[0][1] as { warmHook?: string; startHook?: string };
  assert.equal(sent.warmHook, "pnpm install");
  assert.equal(sent.startHook, "docker compose up -d");

  const old = box(all);
  await deliverSessionSetup(old.client, { environment: withHooks, agentConfig: null, downloadUrl });
  assert.equal((old.sent[0][1] as { warmHook?: string }).warmHook, undefined);
});

test("a box of a user who works as the App is upgraded first when its agent can't ask for tokens", async () => {
  let features = ["session-environment", "agent-config"];
  const order: string[] = [];
  const b = box([]);
  const client = {
    ...b.client,
    features: async () => features,
    upgrade: async () => {
      order.push("upgrade");
      features = [...features, "git-credential"];
    },
    setEnvironment: async () => void order.push("environment"),
  };
  await deliverSessionSetup(client, { environment, agentConfig: null, appIdentity: true, downloadUrl });
  assert.deepEqual(order, ["upgrade", "environment"]);

  // Working as themselves, nothing is upgraded for it.
  let upgraded = false;
  await deliverSessionSetup(
    { ...box(all).client, upgrade: async () => void (upgraded = true) },
    { environment, agentConfig: null, appIdentity: false, downloadUrl },
  );
  assert.equal(upgraded, false);
});

test("a project's skills reach a box that installs them, before its environment", async () => {
  const skills = [{ repo: "anthropics/skills", skills: ["pdf"] }, { repo: "acme/registry", ref: "main", token: "ghs_x" }];
  const current = box([...all, "environment-skills"], { installed: ["pdf"], failed: [{ repo: "acme/registry", error: "gone" }] });
  await deliverSessionSetup(current.client, { environment, agentConfig: null, skills, downloadUrl });
  assert.deepEqual(current.sent.map(([kind]) => kind), ["skills", "environment"]);
  assert.deepEqual(current.sent[0][1], { sources: skills });

  // An older box starts without them; none sends nothing.
  const old = box(all);
  await deliverSessionSetup(old.client, { environment, agentConfig: null, skills, downloadUrl });
  assert.deepEqual(old.sent.map(([kind]) => kind), ["environment"]);
  const none = box([...all, "environment-skills"]);
  await deliverSessionSetup(none.client, { environment, agentConfig: null, skills: [], downloadUrl });
  assert.deepEqual(none.sent.map(([kind]) => kind), ["environment"]);
});

test("skills the box couldn't install don't stop the session starting", async () => {
  const b = box([...all, "environment-skills"]);
  const client = {
    ...b.client,
    setSkills: async (): Promise<SetSkillsResponse> => {
      throw new Error("the box refused");
    },
  };
  await deliverSessionSetup(client, { environment, agentConfig: null, skills: [{ repo: "acme/skills" }], downloadUrl });
  assert.deepEqual(b.sent.map(([kind]) => kind), ["environment"]);
});

test("a box with MCP servers to load is upgraded first when its Codex wouldn't get them", async () => {
  let features = ["session-environment", "agent-config"];
  const order: string[] = [];
  const b = box([]);
  const client = {
    ...b.client,
    features: async () => features,
    upgrade: async () => {
      order.push("upgrade");
      features = [...features, "codex-mcp"];
    },
    setAgentConfig: async () => void order.push("config"),
  };
  await deliverSessionSetup(client, { environment: null, agentConfig, downloadUrl });
  assert.deepEqual(order, ["upgrade", "config"]);

  // No servers: nothing to upgrade for.
  let upgraded = false;
  await deliverSessionSetup(
    { ...box(all).client, upgrade: async () => void (upgraded = true) },
    { environment: null, agentConfig: { ...agentConfig, mcpServers: {} }, downloadUrl },
  );
  assert.equal(upgraded, false);
});
