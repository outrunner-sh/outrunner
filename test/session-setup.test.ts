import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentConfig } from "@/lib/db/agent-config";
import { deliverSessionSetup } from "@/lib/runtime/session-setup";

function box(features: string[]) {
  const sent: Array<[string, unknown]> = [];
  return {
    sent,
    client: {
      features: async () => features,
      setEnvironment: async (req: unknown) => void sent.push(["environment", req]),
      setAgentConfig: async (req: unknown) => void sent.push(["config", req]),
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
