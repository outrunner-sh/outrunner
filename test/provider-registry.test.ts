import assert from "node:assert/strict";
import { test } from "node:test";

import gateways from "@/runtime-agent/internal/claude/providers.json" with { type: "json" };
import { isProviderId, keyProblem, PROVIDER_IDS, PROVIDERS, type ProviderId } from "@/lib/providers/registry";

/** A key shaped as each provider issues one. */
const SAMPLE: Record<ProviderId, string> = {
  openrouter: "sk-or-v1-" + "0123456789abcdef".repeat(4),
  anthropic: "sk-ant-api03-" + "AbCd_-0123456789".repeat(5),
  zai: "0123456789abcdef0123456789abcdef.AbCdEfGh01234567",
  moonshot: "sk-" + "AbCdEf0123456789".repeat(3),
  deepseek: "sk-" + "0123456789abcdef".repeat(2),
};

test("every provider the agent runs is offered, and only those", () => {
  assert.deepEqual(PROVIDER_IDS, Object.keys(gateways));
  for (const id of PROVIDER_IDS) assert.equal(PROVIDERS[id].id, id);
  assert.equal(isProviderId("openrouter"), true);
  assert.equal(isProviderId("toString"), false, "nothing off the prototype");
  assert.equal(isProviderId("https://evil.example"), false);
});

test("a key shaped as its provider issues one is taken, and one the agent would take", () => {
  for (const id of PROVIDER_IDS) {
    assert.equal(keyProblem(id, SAMPLE[id]), null, id);
    // claude.ValidGatewayToken: 20 to 400 printable characters, no space, quote or backslash.
    assert.match(SAMPLE[id], /^[!-~]{20,400}$/);
  }
  for (const id of PROVIDER_IDS) {
    for (const bad of ["", "short", SAMPLE[id] + " x", SAMPLE[id] + "'", "x".repeat(401)]) {
      assert.notEqual(keyProblem(id, bad), null, `${id} took ${JSON.stringify(bad)}`);
    }
  }
});

test("a key pasted into the wrong place says where it goes", () => {
  assert.match(keyProblem("zai", SAMPLE.openrouter) ?? "", /is for OpenRouter/);
  assert.match(keyProblem("deepseek", SAMPLE.anthropic) ?? "", /is for Anthropic/);
  assert.match(keyProblem("anthropic", "sk-ant-oat01-" + "x".repeat(40)) ?? "", /Claude subscription instead/);
  assert.match(keyProblem("moonshot", "nope") ?? "", /doesn't look like a Moonshot \(Kimi\) API key/);
});
