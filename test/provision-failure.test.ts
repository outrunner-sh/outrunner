import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_DETAIL_CHARS, provisionFailureMessage } from "@/lib/runtime/provision-failure";

test("a failure names the step it stopped at and its error", () => {
  assert.equal(
    provisionFailureMessage(new Error("sandbox quota exceeded"), "allocate", []),
    "Setup failed while provisioning the sandbox: sandbox quota exceeded",
  );
});

test("a Supabase error, a plain object, still shows its message", () => {
  const error = { code: "PGRST205", message: "Could not find the table 'public.user_agent_config' in the schema cache" };
  assert.equal(
    provisionFailureMessage(error, "secrets", []),
    "Setup failed while configuring the session: Could not find the table 'public.user_agent_config' in the schema cache",
  );
});

test("a failure before any step, or without a message, still reads as a sentence", () => {
  assert.equal(provisionFailureMessage(new Error("boom"), null, []), "Setup failed: boom");
  assert.equal(
    provisionFailureMessage(undefined, "clone", []),
    "Setup failed while cloning the repository. Start a new session to try again.",
  );
  assert.equal(provisionFailureMessage(new Error("  \n "), null, []), "Setup failed. Start a new session to try again.");
});

test("the session's secrets, and anything shaped like a credential, are cut out", () => {
  const agentSecret = "a".repeat(64);
  const message = provisionFailureMessage(
    new Error(
      `git clone https://x-access-token:opaque-token@github.com/o/r.git failed; ` +
        `agent ${agentSecret} refused; ghp_${"b".repeat(36)} sk-ant-${"c".repeat(40)} Authorization: Bearer xyz.abc`,
    ),
    "clone",
    [agentSecret, undefined, ""],
  );
  assert.equal(
    message,
    "Setup failed while cloning the repository: git clone https://***@github.com/o/r.git failed; agent *** refused; *** *** Authorization: ***",
  );
});

test("a long error is cut to what the page can show", () => {
  const message = provisionFailureMessage(new Error("x".repeat(1000)), null, []);
  assert.equal(message, `Setup failed: ${"x".repeat(MAX_DETAIL_CHARS - 1)}…`);
});
