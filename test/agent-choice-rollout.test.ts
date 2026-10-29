import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentChoiceDeploymentError, saveAgentChoice } from "@/lib/agents/save-choice";
import { codexCliVersion, probeCodexSchema } from "@/lib/codex/rollout";
import type { AgentAuthChoices } from "@/lib/db/credentials";

const previous: AgentAuthChoices = { claude: "subscription", codex: "api-key" };
test("an existing API-key choice survives an absent Codex migration without any write", async () => {
  let writes = 0;
  const store = { read: async () => ({ ...previous }), write: async () => { writes++; }, codexSchema: async () => "missing" as const };
  await assert.rejects(saveAgentChoice(store, "codex", "codex-account"), AgentChoiceDeploymentError);
  assert.equal(writes, 0);
  assert.equal((await store.read()).codex, "api-key");
});
test("a legacy method CHECK failure says deployment update, without exposing database details", async () => {
  const store = { read: async () => ({ ...previous }), codexSchema: async () => "ok" as const,
    write: async () => { throw { code: "23514", message: "private database detail", details: "existing user row" }; } };
  await assert.rejects(saveAgentChoice(store, "codex", "codex-account"), (error: unknown) => {
    assert.ok(error instanceof AgentChoiceDeploymentError);
    assert.match(error.message, /previous sign-in choice and API key are unchanged/);
    assert.doesNotMatch(error.message, /private|existing user row/);
    return true;
  });
});
test("API-key and Claude choices stay usable before the optional Codex migration", async () => {
  for (const [agent, method] of [["codex", "api-key"], ["claude", "subscription"]] as const) {
    let written = false;
    const result = await saveAgentChoice({ read: async () => ({ ...previous }),
      codexSchema: async () => { throw Error("must not probe optional feature"); }, write: async () => { written = true; } }, agent, method);
    assert.equal(written, true);
    assert.deepEqual(result, previous);
  }
});
test("a successful choice returns the committed value without a second read that could falsely report failure", async () => {
  let reads = 0;
  const result = await saveAgentChoice({ read: async () => { assert.equal(++reads, 1); return { ...previous }; },
    codexSchema: async () => "ok", write: async () => {} }, "codex", "codex-account");
  assert.deepEqual(result, { claude: "subscription", codex: "codex-account" });
});
test("Codex readiness requires a zero-row table probe and the actual broker RPC", async () => {
  let rpcCalls = 0;
  const client = { from: (name: string) => { assert.equal(name, "codex_connections"); return { select: (columns: string) => {
    assert.equal(columns, "key"); return { limit: async (count: number) => { assert.equal(count, 0); return { error: null }; } }; } }; },
    rpc: async (_: string, args: Record<string, string | null>) => { rpcCalls++; assert.equal(args.actor, "00000000-0000-0000-0000-000000000000"); return { error: { code: "PGRST202" } }; } };
  assert.equal(await probeCodexSchema(client), "missing");
  assert.equal(rpcCalls, 1);
  assert.equal(await probeCodexSchema({ ...client, rpc: async () => ({ error: null }) }), "ok");
});
test("a supported CLI setting is an immutable exact version rather than a dist tag or command", () => {
  for (const invalid of ["", "latest", "next", "0.1.4 && echo bad", "https://example.com"]) assert.equal(codexCliVersion(invalid), null);
  assert.equal(codexCliVersion("0.1.4"), "0.1.4");
});
