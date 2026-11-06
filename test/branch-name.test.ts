import assert from "node:assert/strict";
import { test } from "node:test";

import { branchSlug, sessionBranch, withoutGeneratedPrefix } from "@/lib/session/branch-name";
import { isValidBranchName } from "@/lib/runtime/git";

test("a branch is a few words of the title, with Outrunner's prefix and the suffix", () => {
  assert.equal(sessionBranch({ title: "first-prompt-server" }, "3fa9c1"), "outrunner/first-prompt-server-3fa9c1");
  assert.equal(sessionBranch({ title: "Fix the login redirect" }, "3fa9c1"), "outrunner/fix-login-redirect-3fa9c1");
});

test("without a title, the first prompt names it, filler words left out", () => {
  assert.equal(
    sessionBranch({ prompt: "Can you please make the first prompt survive the tab closing?\nMore detail here." }, "abc123"),
    "outrunner/make-first-prompt-survive-tab-closing-abc123",
  );
});

test("links, accents and symbols don't reach the branch", () => {
  assert.equal(branchSlug("Fix https://example.com/a?b=c crash in café façade!!"), "fix-crash-cafe-facade");
});

test("a long slug stops at a word, within the limit", () => {
  const slug = branchSlug("refactor authentication middleware every route checks session token");
  assert.ok(slug.length <= 40, slug);
  assert.ok(!slug.endsWith("-"));
  assert.equal(slug, "refactor-authentication-middleware-every");
});

test("nothing to name it by gives a plain session branch", () => {
  assert.equal(sessionBranch({ title: "", prompt: "!!! ??" }, "abc123"), "outrunner/session-abc123");
  assert.equal(sessionBranch({}, "abc123"), "outrunner/session-abc123");
});

test("every generated branch is a valid git branch name", () => {
  for (const about of [{ title: "Ünïcödé — täsk" }, { prompt: "../../etc/passwd" }, { prompt: "a".repeat(500) }, {}]) {
    const branch = sessionBranch(about, "abc123");
    assert.ok(isValidBranchName(branch), branch);
  }
});

test("both generated prefixes are dropped for showing; others are kept", () => {
  assert.equal(withoutGeneratedPrefix("outrunner/fix-login-3fa9c1"), "fix-login-3fa9c1");
  assert.equal(withoutGeneratedPrefix("runtime/mv69bt00-3a01334a"), "mv69bt00-3a01334a");
  assert.equal(withoutGeneratedPrefix("feature/outrunner/x"), "feature/outrunner/x");
});
