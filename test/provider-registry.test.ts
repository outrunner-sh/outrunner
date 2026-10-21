import assert from "node:assert/strict";
import { test } from "node:test";

import gateways from "@/runtime-agent/internal/claude/providers.json" with { type: "json" };
import {
  isKeyProviderId,
  isProviderId,
  KEY_PROVIDER_IDS,
  keyProblem,
  type KeyProviderId,
  PROVIDER_IDS,
  PROVIDERS,
} from "@/lib/providers/registry";

/** A key shaped as each provider issues one. */
const SAMPLE: Record<KeyProviderId, string> = {
  openrouter: "sk-or-v1-" + "0123456789abcdef".repeat(4),
  anthropic: "sk-ant-api03-" + "AbCd_-0123456789".repeat(5),
  zai: "0123456789abcdef0123456789abcdef.AbCdEfGh01234567",
  moonshot: "sk-" + "AbCdEf0123456789".repeat(3),
  deepseek: "sk-" + "0123456789abcdef".repeat(2),
  openai: "sk-proj-" + "AbCd_-0123456789".repeat(5),
};

test("every provider the agent runs is offered, and only those", () => {
  assert.deepEqual(PROVIDER_IDS, Object.keys(gateways));
  for (const id of PROVIDER_IDS) assert.equal(PROVIDERS[id].id, id);
  assert.equal(isProviderId("openrouter"), true);
  assert.equal(isProviderId("toString"), false, "nothing off the prototype");
  assert.equal(isProviderId("https://evil.example"), false);
});

test("OpenAI takes a key, but isn't a gateway Claude Code runs through", () => {
  assert.deepEqual(KEY_PROVIDER_IDS, [...PROVIDER_IDS, "openai"]);
  assert.equal(PROVIDERS.openai.id, "openai");
  assert.equal(isKeyProviderId("openai"), true);
  assert.equal(isProviderId("openai"), false);
  assert.equal(isKeyProviderId("toString"), false, "nothing off the prototype");
});

test("a key shaped as its provider issues one is taken, and one the agent would take", () => {
  for (const id of KEY_PROVIDER_IDS) {
    assert.equal(keyProblem(id, SAMPLE[id]), null, id);
    // claude.ValidGatewayToken: 20 to 400 printable characters, no space, quote or backslash.
    assert.match(SAMPLE[id], /^[!-~]{20,400}$/);
  }
  for (const id of KEY_PROVIDER_IDS) {
    for (const bad of ["", "short", SAMPLE[id] + " x", SAMPLE[id] + "'", "x".repeat(401)]) {
      assert.notEqual(keyProblem(id, bad), null, `${id} took ${JSON.stringify(bad)}`);
    }
  }
});

test("a key pasted into the wrong place says where it goes", () => {
  assert.match(keyProblem("zai", SAMPLE.openrouter) ?? "", /is for OpenRouter/);
  assert.match(keyProblem("deepseek", SAMPLE.anthropic) ?? "", /is for Anthropic/);
  assert.match(keyProblem("anthropic", "sk-ant-oat01-" + "x".repeat(40)) ?? "", /Claude Code → Subscription instead/);
  assert.match(keyProblem("moonshot", "nope") ?? "", /doesn't look like a Moonshot \(Kimi\) API key/);
});

test("OpenAI's keys: project, service account and older ones; never an admin key", () => {
  assert.equal(keyProblem("openai", "sk-svcacct-" + "AbCd0123456789".repeat(3)), null);
  // An older user key looks like DeepSeek's and Moonshot's: OpenAI is asked.
  assert.equal(keyProblem("openai", SAMPLE.deepseek), null);
  assert.equal(keyProblem("deepseek", "sk-" + "AbCd0123456789".repeat(3)), null);
  assert.match(keyProblem("openai", "sk-admin-" + "AbCd0123456789".repeat(3)) ?? "", /admin key, which can't run models/);
  assert.match(keyProblem("deepseek", "sk-admin-" + "AbCd0123456789".repeat(3)) ?? "", /admin key/);
});

test("a key pasted into another agent's or provider's card says where it goes", () => {
  assert.match(keyProblem("deepseek", SAMPLE.openai) ?? "", /is for OpenAI\. Save it under Codex → API key/);
  assert.match(keyProblem("openai", SAMPLE.anthropic) ?? "", /is for Anthropic\. Save it under Claude Code → API key/);
  assert.match(keyProblem("openai", SAMPLE.openrouter) ?? "", /is for OpenRouter\. Save it under OpenRouter instead/);
});
