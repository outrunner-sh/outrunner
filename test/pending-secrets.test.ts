import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent, ContentBlock } from "@/lib/runtime/agent-protocol";
import { pendingSecretRequest, providedValues, SECRETS_TOOL } from "@/lib/runtime/pending-secrets";

function message(role: "user" | "assistant", uuid: string, content: ContentBlock[]): AgentEvent {
  return { t: "message", uuid, parentUuid: null, role, timestamp: "2026-10-27T10:00:00Z", content };
}

const input = {
  reason: "Deploy a preview to Vercel",
  keys: [{ name: "VERCEL_TOKEN", description: "A personal token" }, { name: "VERCEL_ORG", optional: true }],
};
const call = message("assistant", "a1", [{ type: "tool_use", id: "s1", name: SECRETS_TOOL, input }]);
const prompt = message("user", "u0", [{ type: "text", text: "deploy it" }]);

test("the newest request_secrets call without a result is pending", () => {
  const pending = pendingSecretRequest([prompt, call]);
  assert.equal(pending?.toolUseId, "s1");
  assert.equal(pending?.reason, "Deploy a preview to Vercel");
  assert.deepEqual(
    pending?.keys.map((k) => k.name),
    ["VERCEL_TOKEN", "VERCEL_ORG"],
  );
});

test("a request is over once answered, or once a prompt follows it", () => {
  const result = message("user", "r1", [{ type: "tool_result", toolUseId: "s1", content: "The user provided VERCEL_TOKEN." }]);
  assert.equal(pendingSecretRequest([prompt, call, result]), null);
  assert.equal(pendingSecretRequest([prompt, call, message("user", "u1", [{ type: "text", text: "never mind" }])]), null);
  assert.equal(pendingSecretRequest([prompt, call, { t: "state", state: "exited" } as AgentEvent]), null);
});

test("a request that doesn't parse shows no form", () => {
  const bad = message("assistant", "a2", [{ type: "tool_use", id: "s2", name: SECRETS_TOOL, input: { reason: "x", keys: [] } }]);
  assert.equal(pendingSecretRequest([prompt, bad]), null);
});

test("a form sends once every required variable has a value, blanks left out", () => {
  const pending = pendingSecretRequest([prompt, call])!;
  assert.equal(providedValues(pending, { VERCEL_ORG: "org" }), null);
  assert.equal(providedValues(pending, { VERCEL_TOKEN: "  " }), null);
  assert.deepEqual(providedValues(pending, { VERCEL_TOKEN: "tok", VERCEL_ORG: "" }), { VERCEL_TOKEN: "tok" });
});
