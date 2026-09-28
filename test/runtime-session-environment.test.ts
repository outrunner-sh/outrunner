import assert from "node:assert/strict";
import { test } from "node:test";

import { anthropicEnvVar } from "@/lib/runtime/anthropic-env";

/**
 * The two Claude credential kinds are not interchangeable: a subscription token
 * from `claude setup-token` only works as CLAUDE_CODE_OAUTH_TOKEN, and an API
 * key only as ANTHROPIC_API_KEY. Picking the wrong variable fails inside the
 * box, long after the user pasted it, so the mapping is pinned here.
 */
test("a setup-token credential maps to CLAUDE_CODE_OAUTH_TOKEN", () => {
  assert.equal(anthropicEnvVar("sk-ant-oat01-abc123"), "CLAUDE_CODE_OAUTH_TOKEN");
});

test("an API key maps to ANTHROPIC_API_KEY", () => {
  assert.equal(anthropicEnvVar("sk-ant-api03-abc123"), "ANTHROPIC_API_KEY");
});

test("an unrecognised credential is treated as an API key", () => {
  // Anthropic has changed key prefixes before; defaulting to the API variable
  // keeps a new key shape working rather than routing it somewhere it cannot.
  assert.equal(anthropicEnvVar("some-future-shape"), "ANTHROPIC_API_KEY");
});

test("the oat prefix is matched at the start, not anywhere in the string", () => {
  // An API key that merely contains the substring must not be misrouted.
  assert.equal(anthropicEnvVar("sk-ant-api03-sk-ant-oat"), "ANTHROPIC_API_KEY");
});
