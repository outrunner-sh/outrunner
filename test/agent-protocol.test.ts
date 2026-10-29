import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  AGENT_FEATURE_AGENT_CONFIG,
  AGENT_FEATURE_CODEX_GATEWAY,
  AGENT_FEATURE_COMPACT,
  AGENT_FEATURE_EDITOR,
  AGENT_FEATURE_ENVIRONMENT,
  AGENT_FEATURE_FILES,
  AGENT_FEATURE_GIT_CREDENTIAL,
  AGENT_FEATURE_IMPORTS,
  AGENT_FEATURE_MULTI_REPO,
  AGENT_FEATURE_MULTI_REPO_SNAPSHOTS,
  AGENT_FEATURE_MULTI_REPO_WARM,
  AGENT_FEATURE_PLAN_MODE,
  AGENT_FEATURE_PORTS,
  AGENT_FEATURE_RESTORE_MODEL,
  AGENT_FEATURE_SKILLS,
  AGENT_FEATURE_WARM_HOOKS,
  PROTOCOL_SCHEMAS,
  type ProtocolSchemaName,
} from "@/lib/runtime/agent-protocol";

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
  ]) {
    assert.ok(newest.includes(feature), `the newest AgentHealth fixture lacks ${feature}`);
  }
});
