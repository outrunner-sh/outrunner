import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { isValidBranchName } from "@/lib/runtime/git";
import { prInstructions } from "@/lib/session/pr-instructions";
import { branchHint, issueBranch, issueKeyOfUrl, nextFreeBranch, trackerIssueOf, withFreeBranch } from "@/lib/trackers/issue-key";

test("the key is read from either tracker's link", () => {
  assert.equal(issueKeyOfUrl("https://linear.app/acme/issue/ENG-123/checkout-breaks"), "ENG-123");
  assert.equal(issueKeyOfUrl("https://linear.app/acme/issue/ENG-123"), "ENG-123");
  assert.equal(issueKeyOfUrl("https://acme.atlassian.net/browse/PROJ_2-7?focusedCommentId=9"), "PROJ_2-7");
  assert.equal(issueKeyOfUrl("https://example.com/nothing/here"), null);
  assert.equal(issueKeyOfUrl("https://linear.app/acme/issue/not-a-key/x"), null);
  assert.equal(issueKeyOfUrl(null), null);
});

test("only a tracker's item has an issue", () => {
  assert.deepEqual(trackerIssueOf({ source: "linear", sourceUrl: "https://linear.app/a/issue/ENG-1/x" }), { source: "linear", key: "ENG-1" });
  assert.deepEqual(trackerIssueOf({ source: "jira", sourceUrl: "https://a.atlassian.net/browse/ENG-1" }), { source: "jira", key: "ENG-1" });
  assert.equal(trackerIssueOf({ source: "slack", sourceUrl: "https://a.atlassian.net/browse/ENG-1" }), null);
  assert.equal(trackerIssueOf({ source: "linear", sourceUrl: null }), null);
});

test("a branch reads as the issue, with no id on the end", () => {
  assert.equal(issueBranch("linear", "ENG-123", "Checkout breaks on Safari!"), "eng-123-checkout-breaks-on-safari");
  assert.equal(issueBranch("jira", "ENG-123", "Checkout breaks on Safari!"), "ENG-123-checkout-breaks-on-safari", "Jira's integration wants its key uppercase");
  assert.equal(issueBranch("jira", "eng-123", ""), "ENG-123");
  // Nothing of the title that a branch can't have, however it reads.
  for (const title of ["日本語のタイトル", "../../etc/passwd", "a..b~c^d:e", "-- leading", "x".repeat(300), ""]) {
    for (const source of ["linear", "jira"] as const) {
      const named = issueBranch(source, "ENG-1", title);
      assert.equal(isValidBranchName(named), true, title);
      assert.ok(named.toLowerCase().startsWith("eng-1"), title);
      assert.ok(named.length < 60, title);
    }
  }
});

test("a number only on a real clash, in any case", () => {
  assert.equal(nextFreeBranch("eng-1-x", []), "eng-1-x");
  assert.equal(nextFreeBranch("eng-1-x", ["eng-1-x-long-other"]), "eng-1-x");
  assert.equal(nextFreeBranch("eng-1-x", ["eng-1-x"]), "eng-1-x-2");
  assert.equal(nextFreeBranch("eng-1-x", ["ENG-1-X", "eng-1-x-2"]), "eng-1-x-3");
});

test("two starting on one item: the loser takes the next free name, once", async () => {
  const taken = new Error("taken");
  const isTaken = (error: unknown) => error === taken;
  const tried: (string | null)[] = [];
  const insert = (fails: number) => async (branch: string | null) => {
    tried.push(branch);
    if (tried.length <= fails) throw taken;
    return `made on ${branch}`;
  };
  assert.equal(await withFreeBranch("eng-1-x", insert(0), async () => "unused", isTaken), "made on eng-1-x");
  tried.length = 0;
  assert.equal(await withFreeBranch("eng-1-x", insert(1), async () => "eng-1-x-2", isTaken), "made on eng-1-x-2");
  assert.deepEqual(tried, ["eng-1-x", "eng-1-x-2"]);
  tried.length = 0;
  assert.equal(await withFreeBranch("eng-1-x", insert(1), async () => null, isTaken), "made on null", "a generated one then");
  tried.length = 0;
  await assert.rejects(withFreeBranch("eng-1-x", insert(2), async () => "eng-1-x-2", isTaken), /taken/);
  assert.equal(tried.length, 2, "only once more");
  // A branch someone asked for has no second try: that's its own answer, naming who has it.
  tried.length = 0;
  await assert.rejects(withFreeBranch(null, insert(1), async () => assert.fail("not asked"), isTaken), /taken/);
  // Nor anything else that goes wrong, such as the session's own id being taken.
  tried.length = 0;
  await assert.rejects(withFreeBranch("eng-1-x", async () => assert.fail("other"), async () => assert.fail("not asked"), isTaken));
});

test("the create route treats its id being taken as that, not as the name", () => {
  const create = readFileSync("lib/session/create-cloud-session.ts", "utf8");
  assert.match(create, /\(error\) => isUniqueViolation\(error\) && !isIdTaken\(error\)/);
});

test("the agent's hint spells the key as its tracker wants", () => {
  assert.match(branchHint("linear", "ENG-1"), /`fix\/eng-1-what-it-does`/);
  assert.match(branchHint("jira", "ENG-1"), /`fix\/ENG-1-what-it-does`/);
});

test("a branch someone asked for wins; else the issue's name, else a generated one, all the server's", () => {
  const create = readFileSync("lib/session/create-cloud-session.ts", "utf8");
  assert.match(create, /requested: requestedBranch,/);
  // The issue's name is offered first, and the generated one only without it.
  assert.ok(create.indexOf("issueBranches.add(name)") < create.indexOf("return generatedBranch(about, generation, lost)"));
  // Named for its issue, the agent doesn't rename it away from the key.
  assert.match(create, /branchRenamable: !requestedBranch && !issueBranches\.has\(branch\)/);
  // The hook sends no branch at all: the server names every new one.
  const hook = readFileSync("hooks/use-create-session.ts", "utf8");
  assert.doesNotMatch(hook, /\{ branch \}\)/);
});

test("Create PR names the issue as each tracker's GitHub integration reads it", () => {
  const base = { branch: "b", baseBranch: "main", changedFiles: 0, tools: { desktop: true }, footer: { sessionUrl: "https://app/w" } };
  assert.match(prInstructions({ ...base, issue: { source: "linear", key: "ENG-1" } }), /^This session works on Linear issue ENG-1\. Put "Fixes ENG-1" in the PR body\.$/m);
  assert.match(prInstructions({ ...base, issue: { source: "jira", key: "ENG-1" } }), /^This session works on Jira issue ENG-1\. Put ENG-1 in the PR title\.$/m);
  assert.doesNotMatch(prInstructions(base), /works on (Linear|Jira) issue/);
});

test("the route's answer is only for someone who can see the session, and Create PR doesn't depend on it", () => {
  const route = readFileSync("app/api/workspaces/[id]/tracker-issue/route.ts", "utf8");
  assert.match(route, /getOwner\(\)/);
  assert.match(route, /getWorkspace\(id\)/);
  const panel = readFileSync("components/workspace-environment.tsx", "utf8");
  assert.match(panel, /\.catch\(\(\) => null\)/);
});
