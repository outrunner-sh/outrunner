import assert from "node:assert/strict";
import { test } from "node:test";

import { BRANCH_ATTEMPTS, branchSlug, firstFreeBranch, numberedBranch, sessionBranch, withoutGeneratedPrefix } from "@/lib/session/branch-name";
import { isValidBranchName } from "@/lib/runtime/git";

test("a branch is a few words of the title, else of the first prompt, and nothing else", () => {
  assert.equal(sessionBranch({ title: "Fix the login redirect" }), "fix-login-redirect");
  assert.equal(sessionBranch({ title: "verify-prs-372-380", prompt: "Add dark mode" }), "verify-prs-372-380");
  assert.equal(sessionBranch({ prompt: "the right sidebar should be expandable" }), "right-sidebar-expandable");
});

test("no type is guessed: the prompt's own words say what it is", () => {
  assert.equal(sessionBranch({ prompt: "add error handling to the upload route" }), "add-error-handling-upload");
  assert.equal(sessionBranch({ prompt: "add a test mode toggle in settings" }), "add-test-mode-toggle");
  assert.equal(sessionBranch({ prompt: "Run the tests and tell me what fails" }), "run-tests-tell-fails");
  assert.equal(sessionBranch({ prompt: "debug why the box OOMs" }), "debug-box-ooms");
});

test("chat around the task doesn't reach the branch", () => {
  assert.equal(branchSlug("hey, so I was thinking we should probably add dark mode to the settings page"), "add-dark-mode-settings");
  assert.equal(branchSlug("Now it's time to give outrunner to users"), "time-give-outrunner-users");
  assert.equal(
    branchSlug("one issue i found, that outrunner is giving bad branch names. fix this issue. This is a major UX Bug."),
    "outrunner-bad-branch-names",
  );
});

test("a link keeps its issue or pull request number, nothing else", () => {
  assert.equal(sessionBranch({ prompt: "https://github.com/neevai-labs/outrunner/issues/266 fix this" }), "issue-266-fix");
  assert.equal(branchSlug("review https://github.com/o/r/pull/394/files please"), "review-pr-394");
  assert.equal(branchSlug("Fix https://example.com/a?b=c crash in café façade!!"), "fix-crash-cafe-facade");
});

test("a long slug stops at a word, within the limit", () => {
  const slug = branchSlug("authentication middleware every route checks session token");
  assert.ok(slug.length <= 40, slug);
  assert.equal(slug, "authentication-middleware-every-route");
});

test("nothing to name it by gives a plain session branch", () => {
  assert.equal(sessionBranch({ title: "", prompt: "!!! ??" }), "session");
  assert.equal(sessionBranch({ prompt: "ログイン画面を直して" }), "session");
  assert.equal(sessionBranch({}), "session");
});

test("every generated branch is a valid git branch name, numbered too", () => {
  for (const about of [{ title: "Ünïcödé — täsk" }, { prompt: "../../etc/passwd" }, { prompt: "a".repeat(500) }, {}]) {
    for (const n of [1, 2, BRANCH_ATTEMPTS]) {
      const branch = numberedBranch(sessionBranch(about), n);
      assert.ok(isValidBranchName(branch), branch);
    }
  }
});

test("a free name is kept as it is; a taken one gets -2, -3…", async () => {
  assert.equal(await firstFreeBranch("fix-login", () => false), "fix-login");
  const taken = new Set(["fix-login", "fix-login-2"]);
  assert.equal(await firstFreeBranch("fix-login", (b) => taken.has(b)), "fix-login-3");
  const asked: string[] = [];
  await firstFreeBranch("fix-login", async (b) => (asked.push(b), b === "fix-login"));
  assert.deepEqual(asked, ["fix-login", "fix-login-2"]);
  assert.equal(await firstFreeBranch("fix-login", () => true), null);
});

test("only the old meaningless prefix is dropped for showing", () => {
  assert.equal(withoutGeneratedPrefix("runtime/mv69bt00-3a01334a"), "mv69bt00-3a01334a");
  assert.equal(withoutGeneratedPrefix("fix-login"), "fix-login");
});
