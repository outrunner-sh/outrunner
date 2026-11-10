import assert from "node:assert/strict";
import { test } from "node:test";

import { failureParts, GITHUB_RECONNECT_MESSAGE, MAX_DETAIL_CHARS, PLATFORM_CAPACITY_MESSAGE, provisionFailureMessage } from "@/lib/runtime/provision-failure";

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

test("git refused by GitHub says to reconnect, not git's message", () => {
  for (const said of [
    "git -C failed (128): remote: Invalid username or token. Password authentication is not supported for Git operations. fatal: Authentication failed for 'https://github.com/acme/app.git/'",
    "remote: Invalid username or token.",
  ]) {
    assert.equal(provisionFailureMessage(new Error(said), "allocate", []), GITHUB_RECONNECT_MESSAGE);
  }
  // No token at all: git asking for one is not a connection refused.
  assert.match(
    provisionFailureMessage(new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), "clone", []),
    /could not read Username/,
  );
  // Any other clone failure still says what happened.
  assert.match(provisionFailureMessage(new Error("fatal: repository not found"), "clone", []), /repository not found/);
});

test("the page shows a sentence first and what the box said behind Details (NEE-231)", () => {
  assert.deepEqual(failureParts("Setup failed while cloning the repository: fatal: repository not found"), {
    summary: "Setup failed while cloning the repository. Try again to start a fresh session.",
    detail: "fatal: repository not found",
  });
  assert.deepEqual(failureParts("Setup failed: boom"), {
    summary: "Setup failed. Try again to start a fresh session.",
    detail: "boom",
  });
  // Messages with nothing raw in them show as they are.
  for (const message of ["Setup failed while cloning the repository. Start a new session to try again.", GITHUB_RECONNECT_MESSAGE, PLATFORM_CAPACITY_MESSAGE]) {
    assert.deepEqual(failureParts(message), { summary: message, detail: null });
  }
});

test("Outrunner's sandbox account being full is said as Outrunner's, never as the user's Daytona org", () => {
  const daytona = new Error(
    "Total disk limit exceeded. Maximum allowed: 2000GiB. Consider archiving your unused Sandboxes to free up available storage. " +
      "To increase concurrency limits, upgrade your organization's Tier by visiting https://app.daytona.io/dashboard/limits.",
  );
  assert.equal(provisionFailureMessage(daytona, "allocate", [], true), PLATFORM_CAPACITY_MESSAGE);
  assert.doesNotMatch(PLATFORM_CAPACITY_MESSAGE, /daytona/i);
  assert.equal(provisionFailureMessage(new Error("Sandbox limit exceeded"), "allocate", [], true), PLATFORM_CAPACITY_MESSAGE);
  // On the user's own Daytona account, it's theirs to fix: Daytona's words stand.
  assert.match(provisionFailureMessage(daytona, "allocate", [], false), /^Setup failed while provisioning the sandbox: Total disk limit exceeded/);
  assert.equal(provisionFailureMessage(daytona, null, [], true), PLATFORM_CAPACITY_MESSAGE);
  // Out of room inside the box, in a later step, is that step's own failure.
  assert.equal(
    provisionFailureMessage(new Error("fatal: write error: Disk quota exceeded"), "clone", [], true),
    "Setup failed while cloning the repository: fatal: write error: Disk quota exceeded",
  );
  assert.match(provisionFailureMessage(new Error("memory limit exceeded"), "install", [], true), /^Setup failed while installing dependencies: memory limit exceeded/);
  // Anything else on Outrunner's account still says what it was.
  assert.equal(
    provisionFailureMessage(new Error("snapshot not found"), "allocate", [], true),
    "Setup failed while provisioning the sandbox: snapshot not found",
  );
});
