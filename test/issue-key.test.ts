import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { isValidBranchName } from "@/lib/runtime/git";
import { prInstructions } from "@/lib/session/pr-instructions";
import { insertOnBranch } from "@/lib/session/generated-branch";
import { branchHint, freeIssueBranchOf, issueBranch, issueBranchFor, issueFirstBranch, issueKeyOfUrl, nextFreeBranch, trackerIssueOf } from "@/lib/trackers/issue-key";

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

test("two starting on one item: the loser takes the issue's next free name, then a generated one", async () => {
  const taken = new Error("taken");
  const isBranchTaken = (error: unknown) => error === taken;
  // Inserting fails `fails` times as taken, then makes the row.
  const start = (first: string | null, fails: number, next: string | null, requested = "") => {
    const tried: string[] = [];
    const issueNamed = new Set<string>();
    const made = insertOnBranch({
      requested,
      generate: (lost) => issueFirstBranch({ first, lost, next: async () => next, generated: async () => `gen-${lost.size}`, issueNamed }),
      insert: async (branch) => {
        tried.push(branch);
        if (tried.length <= fails) throw taken;
        return branch;
      },
      isBranchTaken,
    });
    return { made, tried, issueNamed };
  };
  let run = start("eng-1-x", 0, "unused");
  assert.equal(await run.made, "eng-1-x");
  assert.deepEqual([...run.issueNamed], ["eng-1-x"]);
  run = start("eng-1-x", 1, "eng-1-x-2");
  assert.equal(await run.made, "eng-1-x-2");
  assert.deepEqual(run.tried, ["eng-1-x", "eng-1-x-2"]);
  // The next free one lost too (or none found): a generated name, not the key's.
  run = start("eng-1-x", 2, "eng-1-x-2");
  assert.equal(await run.made, "gen-2");
  assert.deepEqual(run.tried, ["eng-1-x", "eng-1-x-2", "gen-2"]);
  assert.ok(!run.issueNamed.has("gen-2"), "a generated branch may be renamed");
  run = start("eng-1-x", 1, null);
  assert.equal(await run.made, "gen-1");
  // Not on an issue: generated from the start.
  run = start(null, 0, "unused");
  assert.equal(await run.made, "gen-0");
  assert.equal(run.issueNamed.size, 0);
  // A branch someone asked for has no second try: that's its own answer.
  run = start("eng-1-x", 1, "eng-1-x-2", "their-branch");
  await assert.rejects(run.made, /taken/);
  assert.deepEqual(run.tried, ["their-branch"]);
});

test("the create route treats its id being taken as that, not as the name", () => {
  const create = readFileSync("lib/session/create-cloud-session.ts", "utf8");
  assert.match(create, /\(error\) => isUniqueViolation\(error\) && !isIdTaken\(error\)/);
});

test("the agent's hint spells the key as its tracker wants", () => {
  assert.match(branchHint("linear", "ENG-1"), /`fix\/eng-1-what-it-does`/);
  assert.match(branchHint("jira", "ENG-1"), /`fix\/ENG-1-what-it-does`/);
});

test("the server names a new session's branch through issueFirstBranch, and the hook sends none", () => {
  const create = readFileSync("lib/session/create-cloud-session.ts", "utf8");
  assert.match(create, /requested: requestedBranch,/);
  assert.match(create, /issueFirstBranch\(\{/);
  // Named for its issue, the agent doesn't rename it away from the key.
  assert.match(create, /branchRenamable: !requestedBranch && !issueBranches\.has\(branch\)/);
  const hook = readFileSync("hooks/use-create-session.ts", "utf8");
  assert.doesNotMatch(hook, /\{ branch \}\)/);
});

test("Create PR names the issue as each tracker's GitHub integration reads it", () => {
  const base = { branch: "b", baseBranch: "main", changedFiles: 0, tools: { desktop: true }, footer: { sessionUrl: "https://app/w" } };
  assert.match(prInstructions({ ...base, issue: { source: "linear", key: "ENG-1" } }), /^This session works on Linear issue ENG-1\. Put "Fixes ENG-1" in the PR body\.$/m);
  assert.match(prInstructions({ ...base, issue: { source: "jira", key: "ENG-1" } }), /^This session works on Jira issue ENG-1\. Put ENG-1 in the PR title\.$/m);
  assert.doesNotMatch(prInstructions(base), /works on (Linear|Jira) issue/);
  // A stand-in branch on an issue is renamed with its key kept.
  const renamed = prInstructions({ ...base, nameBranch: true, issue: { source: "linear", key: "ENG-1" } });
  assert.match(renamed, /rename-branch <type>\/<what-it-does>`\)\. Keep ENG-1 in any branch you name/);
  assert.doesNotMatch(prInstructions({ ...base, nameBranch: true }), /Keep .* in any branch you name/);
});

test("the route's answer is only for someone who can see the session, and Create PR doesn't depend on it", () => {
  const route = readFileSync("app/api/workspaces/[id]/tracker-issue/route.ts", "utf8");
  assert.match(route, /getOwner\(\)/);
  assert.match(route, /getWorkspace\(id\)/);
  const panel = readFileSync("components/workspace-environment.tsx", "utf8");
  assert.match(panel, /\.catch\(\(\) => null\)/);
});

test("an issue's branch is free of the project's sessions and of GitHub: a person's own is never reused", async () => {
  const onGitHub = (names: string[]) => async (branch: string) => names.includes(branch);
  assert.equal(await freeIssueBranchOf("eng-1-x", [], onGitHub([])), "eng-1-x");
  assert.equal(await freeIssueBranchOf("eng-1-x", [], onGitHub(["eng-1-x"])), "eng-1-x-2", "a person made it on GitHub");
  assert.equal(await freeIssueBranchOf("eng-1-x", ["eng-1-x"], onGitHub(["eng-1-x-2"])), "eng-1-x-3");
  assert.equal(await freeIssueBranchOf("eng-1-x", ["ENG-1-X"], onGitHub([])), "eng-1-x-2", "any case");
  // GitHub not asked, or failing: the project's sessions alone decide.
  assert.equal(await freeIssueBranchOf("eng-1-x", ["eng-1-x"], null), "eng-1-x-2");
  assert.equal(await freeIssueBranchOf("eng-1-x", [], async () => { throw new Error("GitHub down"); }), "eng-1-x");
});

test("which issue branch a session tries first: a tracker's issue, else a Triage item's, none when one was asked for", async () => {
  const asked: string[] = [];
  const deps = {
    forIssue: async (issue: { source: string; key: string }, title: string) => (asked.push(`issue ${issue.key} ${title}`), `${issue.key.toLowerCase()}-x`),
    forItem: async (itemId: string) => (asked.push(`item ${itemId}`), "eng-9-from-item"),
  };
  const linear = { source: "linear" as const, key: "ENG-1" };
  assert.equal(await issueBranchFor({ requestedBranch: "", issue: linear, workItemId: null, title: "Fix it" }, deps), "eng-1-x");
  assert.equal(await issueBranchFor({ requestedBranch: "", issue: null, workItemId: "item-1", title: "" }, deps), "eng-9-from-item");
  assert.equal(await issueBranchFor({ requestedBranch: "", issue: linear, workItemId: "item-1", title: "Fix it" }, deps), "eng-1-x", "the tracker's issue first");
  assert.equal(await issueBranchFor({ requestedBranch: "my-branch", issue: linear, workItemId: "item-1", title: "Fix it" }, deps), null, "a branch asked for is used as asked");
  assert.equal(await issueBranchFor({ requestedBranch: "", issue: null, workItemId: null, title: "" }, deps), null);
  assert.deepEqual(asked, ["issue ENG-1 Fix it", "item item-1", "issue ENG-1 Fix it"]);
  // Failing is none, never a session that fails over its name.
  const failing = { forIssue: async () => { throw new Error("database down"); }, forItem: async () => { throw new Error("database down"); } };
  assert.equal(await issueBranchFor({ requestedBranch: "", issue: linear, workItemId: null, title: "x" }, failing), null);
  assert.equal(await issueBranchFor({ requestedBranch: "", issue: null, workItemId: "item-1", title: "" }, failing), null);
  // GitHub throwing, through the real picker: the project's sessions alone decide.
  const throughGitHub = {
    forIssue: (issue: { source: "linear" | "jira"; key: string }, title: string) =>
      freeIssueBranchOf(issueBranch(issue.source, issue.key, title), ["eng-1-fix-it"], async () => { throw new Error("GitHub down"); }),
    forItem: async () => null,
  };
  assert.equal(await issueBranchFor({ requestedBranch: "", issue: linear, workItemId: null, title: "Fix it" }, throughGitHub), "eng-1-fix-it-2");
});
