import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  AGENT_FEATURE_AGENT_CONFIG,
  AGENT_FEATURE_CANVAS,
  AGENT_FEATURE_AGENT_CONTEXT,
  AGENT_FEATURE_CHAT_SNAPSHOTS,
  AGENT_FEATURE_CHATS,
  AGENT_FEATURE_CODEX_GATEWAY,
  AGENT_FEATURE_CODEX_MCP,
  AGENT_FEATURE_COMPACT,
  AGENT_FEATURE_EDITOR,
  AGENT_FEATURE_ENVIRONMENT,
  AGENT_FEATURE_FILES,
  AGENT_FEATURE_GIT_CREDENTIAL,
  AGENT_FEATURE_IMPORTS,
  AGENT_FEATURE_MESSAGE_KEYS,
  AGENT_FEATURE_MULTI_REPO,
  AGENT_FEATURE_MULTI_REPO_SNAPSHOTS,
  AGENT_FEATURE_MULTI_REPO_WARM,
  AGENT_FEATURE_PLAN_MODE,
  AGENT_FEATURE_PORTS,
  AGENT_FEATURE_RESTORE_MODEL,
  AGENT_FEATURE_SKILLS,
  AGENT_FEATURE_REWIND,
  AGENT_FEATURE_WARM_HOOKS,
  PROTOCOL_SCHEMAS,
  type ProtocolSchemaName,
} from "@/lib/runtime/agent-protocol";
import { SnapshotManifest } from "@/lib/runtime/snapshot/manifest";

/**
 * The golden fixtures are the shared source of truth between this (zod) side and
 * the Go agent. Every fixture must validate against its named schema; this is
 * the TS half of the two-language drift guard.
 */
const fixtures = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "lib/runtime/agent-protocol.fixtures.json"),
    "utf8",
  ),
) as Record<string, unknown[]>;

test("every schema in the registry has at least one golden fixture", () => {
  for (const name of Object.keys(PROTOCOL_SCHEMAS)) {
    assert.ok(
      Array.isArray(fixtures[name]) && fixtures[name].length > 0,
      `missing fixtures for ${name}`,
    );
  }
});

test("every golden fixture validates against its schema", () => {
  for (const [name, examples] of Object.entries(fixtures)) {
    const schema = PROTOCOL_SCHEMAS[name as ProtocolSchemaName];
    assert.ok(schema, `no schema registered for fixture "${name}"`);
    for (const example of examples) {
      const result = schema.safeParse(example);
      assert.ok(
        result.success,
        `fixture ${name} failed: ${result.success ? "" : JSON.stringify(result.error.issues)}`,
      );
    }
  }
});

test("schemas reject malformed messages", () => {
  assert.equal(
    PROTOCOL_SCHEMAS.PtyClientMessage.safeParse({ t: "nope" }).success,
    false,
  );
  assert.equal(
    PROTOCOL_SCHEMAS.RuntimeTokenClaims.safeParse({
      workspaceId: "ws-1",
      projectId: "p",
      computerId: "c",
      userId: "u",
      exp: -1,
    }).success,
    false,
  );
  assert.equal(
    PROTOCOL_SCHEMAS.ErrorResponse.safeParse({
      error: { code: "NOT_A_CODE", message: "x" },
    }).success,
    false,
  );
  assert.equal(
    PROTOCOL_SCHEMAS.SessionUrls.safeParse({ ptyUrl: "not-a-url" }).success,
    false,
  );
  assert.equal(
    PROTOCOL_SCHEMAS.SessionUrls.safeParse({}).success,
    false,
    "ptyUrl is required",
  );
});

test("a session credential fits its kind, and none takes no token", () => {
  const key = "sk-proj-0123456789abcdef0123456789";
  const { SetAuthRequest } = PROTOCOL_SCHEMAS;
  assert.equal(SetAuthRequest.safeParse({ kind: "none", token: key }).success, false);
  assert.equal(SetAuthRequest.safeParse({ kind: "openai-api-key" }).success, false);
  assert.equal(SetAuthRequest.safeParse({ kind: "openai-api-key", token: "short" }).success, false);
  assert.equal(SetAuthRequest.safeParse({ kind: "openai-api-key", token: `${key}'; rm -rf ~` }).success, false);
  assert.equal(SetAuthRequest.safeParse({ kind: "chatgpt", token: key }).success, false);
});

test("a rollout may join an archive or a restore, but never replace what they need", () => {
  const upload = (artifact: string) => ({ artifact, url: `https://s.example/${artifact}` });
  const six = ["conversation", "cast", "bundle", "patch", "summary", "manifest"];
  const archive = (artifacts: string[]) =>
    PROTOCOL_SCHEMAS.ArchiveWorkspaceRequest.safeParse({ archivedAt: "t", uploads: artifacts.map(upload) }).success;
  assert.equal(archive(six), true);
  assert.equal(archive([...six, "rollout"]), true);
  assert.equal(archive([...six, "rollout", "rollout"]), false, "no duplicates");
  assert.equal(archive([...six.slice(1), "rollout"]), false, "the conversation is still required");

  const restore = (agent: string, artifacts: string[]) =>
    PROTOCOL_SCHEMAS.RestoreWorkspaceRequest.safeParse({
      branch: "b",
      sessionId: "s",
      agent,
      downloads: artifacts.map(upload),
    }).success;
  assert.equal(restore("codex", ["bundle", "patch", "conversation", "rollout"]), true);
  assert.equal(restore("codex", ["bundle", "patch", "rollout"]), false, "the conversation is still required");
  assert.equal(restore("gemini", ["bundle", "patch", "conversation"]), false);
});

test("a restore may bring the session's model: through a gateway on its key, or neither", () => {
  const key = "sk-or-v1-" + "k".repeat(40);
  const restore = (model: unknown) =>
    PROTOCOL_SCHEMAS.RestoreWorkspaceRequest.safeParse({
      branch: "b",
      sessionId: "s",
      downloads: ["bundle", "patch", "conversation"].map((artifact) => ({ artifact, url: `https://s.example/${artifact}` })),
      model,
    }).success;
  assert.equal(restore(undefined), true);
  assert.equal(restore({ model: "z-ai/glm-5.3", gateway: "openrouter", token: key }), true);
  assert.equal(restore({ model: "opus", effort: "high" }), true);
  assert.equal(restore({ model: "z-ai/glm-5.3", gateway: "openrouter" }), false, "a gateway needs its key");
  assert.equal(restore({ model: "opus", token: key }), false, "only a gateway takes one");
  assert.equal(restore({ model: "z-ai/glm-5.3", gateway: "openrouter", token: "it's" + "x".repeat(20) }), false, "a key a shell file can hold");
});

test("the newest health fixture names every feature the agent and the control plane share", () => {
  const health = fixtures.AgentHealth as { features?: string[] }[];
  const newest = health[health.length - 1].features ?? [];
  for (const feature of [
    AGENT_FEATURE_IMPORTS,
    AGENT_FEATURE_ENVIRONMENT,
    AGENT_FEATURE_AGENT_CONFIG,
    AGENT_FEATURE_RESTORE_MODEL,
    AGENT_FEATURE_EDITOR,
    AGENT_FEATURE_PORTS,
    AGENT_FEATURE_CODEX_GATEWAY,
    AGENT_FEATURE_WARM_HOOKS,
    AGENT_FEATURE_MULTI_REPO,
    AGENT_FEATURE_MULTI_REPO_SNAPSHOTS,
    AGENT_FEATURE_GIT_CREDENTIAL,
    AGENT_FEATURE_MULTI_REPO_WARM,
    AGENT_FEATURE_PLAN_MODE,
    AGENT_FEATURE_COMPACT,
    AGENT_FEATURE_FILES,
    AGENT_FEATURE_SKILLS,
    AGENT_FEATURE_CODEX_MCP,
    AGENT_FEATURE_CANVAS,
    AGENT_FEATURE_AGENT_CONTEXT,
    AGENT_FEATURE_MESSAGE_KEYS,
    AGENT_FEATURE_CHATS,
    AGENT_FEATURE_CHAT_SNAPSHOTS,
    AGENT_FEATURE_REWIND,
  ]) {
    assert.ok(newest.includes(feature), `the newest AgentHealth fixture lacks ${feature}`);
  }
});

test("a chat is made with an id of the agent's, and a side chat only about another", () => {
  const create = (req: unknown) => PROTOCOL_SCHEMAS.CreateChatRequest.safeParse(req).success;
  assert.equal(create({ chatId: "3f6c1d2e-7a8b-4c9d-8e0f-1a2b3c4d5e6f" }), true);
  assert.equal(create({ chatId: "main" }), false, "the main chat is the session itself");
  assert.equal(create({ chatId: "../x" }), false, "an id a file can be named by");
  assert.equal(create({ chatId: "b7e1", from: "main", side: true }), true);
  assert.equal(create({ chatId: "b7e1", side: true }), false, "a side chat names the chat it's about");
  assert.equal(create({ chatId: "b7e1", agent: "gemini" }), false);
});

test("a Snapshot's chats sit under chats/<id>/, and an archive or restore names them", () => {
  const manifests = (JSON.parse(readFileSync(path.join(process.cwd(), "lib/runtime/snapshot/manifest.fixtures.json"), "utf8")) as { valid: Record<string, unknown>[] }).valid;
  const withChats = manifests.find((m) => Array.isArray(m.chats));
  assert.ok(withChats, "a golden manifest with chats");
  const moved = structuredClone(withChats) as { chats: { conversation: string }[] };
  moved.chats[0].conversation = "chats/elsewhere/conversation.jsonl";
  assert.equal(SnapshotManifest.safeParse(moved).success, false, "a chat's conversation is under its own id");
  const restore = structuredClone(fixtures.RestoreWorkspaceRequest[0]) as { chats: { chatId: string }[] };
  restore.chats[0].chatId = "main";
  assert.equal(PROTOCOL_SCHEMAS.RestoreWorkspaceRequest.safeParse(restore).success, false, "the main chat is the session's own");
});

test("archive and restore accept more than 100 chats", () => {
  const chatId = (index: number) => `chat-${index}`;
  const archiveChats = Array.from({ length: 101 }, (_, index) => ({
    chatId: chatId(index),
    name: `Chat ${index}`,
    kind: "chat" as const,
    forkedFrom: null,
    agent: "claude" as const,
    model: null,
    conversation: `https://s.example/chats/${chatId(index)}/conversation`,
  }));
  const restoreChats = archiveChats.map(({ chatId, conversation }) => ({ chatId, sessionId: null, conversation }));
  const uploads = ["conversation", "cast", "bundle", "patch", "summary", "manifest"].map((artifact) => ({
    artifact,
    url: `https://s.example/${artifact}`,
  }));

  assert.equal(PROTOCOL_SCHEMAS.ArchiveWorkspaceRequest.safeParse({ archivedAt: "t", uploads, chats: archiveChats }).success, true);
  assert.equal(
    PROTOCOL_SCHEMAS.RestoreWorkspaceRequest.safeParse({
      branch: "b",
      sessionId: "s",
      downloads: ["bundle", "patch", "conversation"].map((artifact) => ({ artifact, url: `https://s.example/${artifact}` })),
      chats: restoreChats,
    }).success,
    true,
  );
});
