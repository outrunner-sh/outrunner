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
      setAgentContext: async (req: unknown) => void sent.push(["context", req]),
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

test("the learnings block reaches a box that takes it after setup; empty does not upgrade an old box", async () => {
  const current = box([...all, "agent-context"]);
  await deliverSessionSetup(current.client, { environment: null, agentConfig, agentContext: "# Outrunner learnings", downloadUrl });
  assert.deepEqual(current.sent.map(([kind]) => kind), ["config", "context"]);
  assert.deepEqual(current.sent[1][1], { content: "# Outrunner learnings" });

  const cleared = box([...all, "agent-context"]);
  await deliverSessionSetup(cleared.client, { environment: null, agentConfig: null, agentContext: "", downloadUrl });
  assert.deepEqual(cleared.sent, [["context", { content: "" }]]);

  let upgrades = 0;
  const old = box(all);
  const client = { ...old.client, upgrade: async () => void upgrades++ };
  await deliverSessionSetup(client, { environment: null, agentConfig: null, agentContext: "", downloadUrl });
  assert.equal(upgrades, 0);
  await deliverSessionSetup(client, { environment: null, agentConfig: null, agentContext: "# Outrunner learnings", downloadUrl });
  assert.equal(upgrades, 1);
  assert.deepEqual(old.sent, []);
});

test("a Codex session's box with MCP servers to load is upgraded first when its Codex wouldn't get them", async () => {
  let features = ["session-environment", "agent-config", "codex-request-secrets"];
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
  await deliverSessionSetup(client, { environment: null, agentConfig, agent: "codex", downloadUrl });
  assert.deepEqual(order, ["upgrade", "config"]);

  // No servers, or a Claude session, whose Claude has always had them:
  // nothing to reboot the agent for, nor any word of Codex in the log.
  for (const setup of [
    { agentConfig: { ...agentConfig, mcpServers: {} }, agent: "codex" as const },
    { agentConfig, agent: "claude" as const },
    { agentConfig },
  ]) {
    let upgraded = false;
    const warned: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args);
    try {
      await deliverSessionSetup(
        { ...box([...all, "codex-request-secrets"]).client, upgrade: async () => void (upgraded = true) },
        { environment: null, ...setup, downloadUrl },
      );
    } finally {
      console.warn = warn;
    }
    assert.equal(upgraded, false, JSON.stringify(setup.agent));
    assert.ok(!JSON.stringify(warned).includes("Codex"), JSON.stringify(warned));
  }
});

test("a box that refuses the learnings' block still starts the session", async () => {
  const b = box([...all, "agent-context"]);
  const client = { ...b.client, setAgentContext: async () => Promise.reject(new Error("400 INVALID_REQUEST: too large")) };
  await deliverSessionSetup(client, { environment, agentConfig: null, agentContext: "# Outrunner learnings", downloadUrl });
  assert.deepEqual(b.sent.map(([kind]) => kind), ["environment"]);
});

test("one setup reuses capabilities, and an upgrade invalidates the snapshot", async () => {
  let reads = 0;
  let upgrades = 0;
  const sent: string[] = [];
  await deliverSessionSetup({
    features: async () => {
      reads++;
      return upgrades ? ["git-credential", "agent-config", "skills", "agent-context", "project-instructions", "warm-hooks", "session-environment"] : [];
    },
    upgrade: async () => { upgrades++; },
    setAgentConfig: async () => { sent.push("config"); },
    setAgentContext: async () => { sent.push("context"); },
    setSkills: async () => ({ installed: [] }),
    setEnvironment: async () => { sent.push("environment"); },
  }, {
    appIdentity: true,
    agentConfig,
    agentContext: "Use the project's conventions.",
    environment: { ...environment, instructions: "Use pnpm.", hooks: { warm: "true", start: "true" } },
    downloadUrl,
  });
  assert.equal(upgrades, 1);
  assert.equal(reads, 2);
  assert.deepEqual(sent, ["config", "context", "environment"]);
});

test("a transient capability read failure can be retried within the setup", async () => {
  const { cachedFeatures } = await import("@/lib/runtime/box-features");
  let reads = 0;
  const client = cachedFeatures({ features: async () => {
    if (++reads === 1) throw new Error("temporary disconnect");
    return ["ready"];
  } });
  await assert.rejects(client.features(), /temporary disconnect/);
  assert.deepEqual(await client.features(), ["ready"]);
  assert.deepEqual(await client.features(), ["ready"]);
  assert.equal(reads, 2);
});


test("a Codex session upgrades for secret forms even without imported MCP servers", async () => {
  let features = [...all];
  let upgrades = 0;
  await deliverSessionSetup({
    ...box(all).client,
    features: async () => features,
    upgrade: async () => { upgrades++; features = [...features, "codex-request-secrets"]; },
  }, { environment: null, agentConfig: null, agent: "codex", downloadUrl });
  assert.equal(upgrades, 1);
});

test("a session's own subagents go to a Claude session's box that takes them, and to no Codex one", async () => {
  const subagents = { reviewer: { description: "Reviews", prompt: "Review it.", model: "sonnet" as const } };
  const takes = box([...all, "subagents"]);
  await deliverSessionSetup(takes.client, { environment: { ...environment, env: {}, files: {}, setup: null }, agentConfig: null, subagents, downloadUrl });
  assert.deepEqual(takes.sent, [["environment", { env: {}, subagents }]]);

  const old = box(all);
  await deliverSessionSetup(old.client, { environment: { ...environment, env: {}, files: {}, setup: null }, agentConfig: null, subagents, downloadUrl });
  assert.deepEqual(old.sent, [], "a box that can't take them is sent nothing for them");

  const codex = box([...all, "subagents", "codex-request-secrets"]);
  await deliverSessionSetup(codex.client, { environment, agentConfig: null, subagents, agent: "codex", downloadUrl });
  assert.equal((codex.sent.find(([kind]) => kind === "environment")?.[1] as { subagents?: unknown }).subagents, undefined);
});
