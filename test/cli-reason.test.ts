import assert from "node:assert/strict";
import { test } from "node:test";

import { cliReason } from "@/lib/desktop/cli-reason";

test("a failed login keeps the line that says why, not the link and prompts around it", () => {
  // What `claude auth login` printed when it couldn't save to the keychain.
  const said = [
    "Opening browser to sign in…",
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=abc",
    "Login failed: Couldn't save your login. If your Mac's keychain is locked, unlock it and log in again.",
    "Paste code here if prompted >",
  ].join(" | ");
  assert.equal(
    cliReason(said),
    "Login failed: Couldn't save your login. If your Mac's keychain is locked, unlock it and log in again.",
  );
});

test("without an error-like line, the last line that isn't noise is kept", () => {
  assert.equal(cliReason("Opening browser to sign in… | Something unexpected happened | Paste code here"), "Something unexpected happened");
});

test("nothing but noise leaves nothing to show", () => {
  assert.equal(cliReason("Opening browser to sign in… | https://claude.com/x"), "");
  assert.equal(cliReason(""), "");
});
