import assert from "node:assert/strict";
import { test } from "node:test";

import { branchSlug, branchType, sessionBranch, withoutGeneratedPrefix } from "@/lib/session/branch-name";
import { isValidBranchName } from "@/lib/runtime/git";

test("a branch is <type>/<description>-<suffix>, from the title first", () => {
  assert.equal(sessionBranch({ title: "Fix the login redirect" }, "3fa9c1"), "fix/login-redirect-3fa9c1");
  assert.equal(sessionBranch({ title: "verify-prs-372-380", prompt: "Add dark mode" }, "3fa9c1"), "chore/verify-prs-372-380-3fa9c1");
});

test("without a title, the first prompt names it", () => {
  assert.equal(sessionBranch({ prompt: "the right sidebar should be expandable" }, "abc123"), "feat/right-sidebar-expandable-abc123");
  assert.equal(
    sessionBranch({ prompt: "Can you look into why sign in fails with Google? Users see 'Sign-in failed'" }, "abc123"),
    "fix/sign-fails-google-users-abc123",
  );
});

test("the type is the first convention the prompt fits; building something otherwise", () => {
  assert.equal(branchType("the checkout page crashes on Safari"), "fix");
  assert.equal(branchType("Update the README with setup steps"), "docs");
  assert.equal(branchType("write tests for the billing module"), "test");
  assert.equal(branchType("refactor the auth middleware"), "refactor");
  assert.equal(branchType("the dashboard is slow to load"), "perf");
  assert.equal(branchType("Review PR #394 and resolve the comments"), "chore");
  assert.equal(branchType("add dark mode to settings"), "feat");
  // A broken test is a fix.
  assert.equal(branchType("fix the flaky test in billing"), "fix");
});

test("chat around the task doesn't reach the branch", () => {
  assert.equal(branchSlug("hey, so I was thinking we should probably add dark mode to the settings page"), "add-dark-mode-settings");
  assert.equal(branchSlug("Now it's time to give outrunner to users"), "time-give-outrunner-users");
});

test("a link keeps its issue or pull request number, nothing else", () => {
  assert.equal(sessionBranch({ prompt: "https://github.com/neevai-labs/outrunner/issues/266 fix this" }, "abc123"), "fix/issue-266-abc123");
  assert.equal(branchSlug("review https://github.com/o/r/pull/394/files please"), "review-pr-394");
  assert.equal(branchSlug("Fix https://example.com/a?b=c crash in café façade!!"), "crash-cafe-facade");
});

test("a long slug stops at a word, within the limit", () => {
  const slug = branchSlug("authentication middleware every route checks session token");
  assert.ok(slug.length <= 40, slug);
  assert.equal(slug, "authentication-middleware-every-route");
});

test("nothing to name it by gives a plain session branch", () => {
  assert.equal(sessionBranch({ title: "", prompt: "!!! ??" }, "abc123"), "feat/session-abc123");
  assert.equal(sessionBranch({}, "abc123"), "feat/session-abc123");
});

test("every generated branch is a valid git branch name", () => {
  for (const about of [{ title: "Ünïcödé — täsk" }, { prompt: "../../etc/passwd" }, { prompt: "a".repeat(500) }, {}]) {
    const branch = sessionBranch(about, "abc123");
    assert.ok(isValidBranchName(branch), branch);
  }
});

test("only the old meaningless prefix is dropped for showing", () => {
  assert.equal(withoutGeneratedPrefix("runtime/mv69bt00-3a01334a"), "mv69bt00-3a01334a");
  assert.equal(withoutGeneratedPrefix("fix/login-3fa9c1"), "fix/login-3fa9c1");
});

test("an issue without its number says nothing", () => {
  assert.equal(
    sessionBranch({ prompt: "one issue i found, that outrunner is giving bad branch names. fix this issue. This is a major UX Bug." }, "abc123"),
    "fix/outrunner-bad-branch-names-abc123",
  );
});
