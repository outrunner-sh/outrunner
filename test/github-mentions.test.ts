import assert from "node:assert/strict";
import { test } from "node:test";

import {
  commentBlock,
  followUpPrompt,
  isBot,
  mentionKey,
  mentionNames,
  mentionsOutrunner,
  mentionTitle,
  readMention,
  replyText,
  skipsOutrunner,
  startPrompt,
  stripMentions,
} from "@/lib/github/mentions";

const SLUG = "outrunner-connector";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function issueComment(over: { body?: string; user?: Record<string, unknown>; action?: string; pull?: boolean; association?: string } = {}) {
  return {
    action: over.action ?? "created",
    installation: { id: 42 },
    repository: { full_name: "neevai-labs/outrunner" },
    issue: {
      number: 12,
      title: "Login is slow",
      body: "It takes 5 seconds.",
      html_url: "https://github.com/neevai-labs/outrunner/issues/12",
      ...(over.pull && { pull_request: { url: "https://api.github.com/repos/neevai-labs/outrunner/pulls/12" } }),
    },
    comment: {
      id: 900,
      body: over.body ?? "@outrunner please look into this",
      html_url: "https://github.com/neevai-labs/outrunner/issues/12#issuecomment-900",
      author_association: over.association ?? "MEMBER",
      user: { id: 7, login: "ada", type: "User", ...over.user },
    },
  };
}

function reviewComment(body = "@outrunner-connector rename this") {
  return {
    action: "created",
    installation: { id: 42 },
    repository: { full_name: "neevai-labs/outrunner" },
    pull_request: {
      number: 30,
      title: "Faster login",
      body: "Caches the session.",
      html_url: "https://github.com/neevai-labs/outrunner/pull/30",
      head: { ref: "feature/login", sha: SHA, repo: { full_name: "neevai-labs/outrunner" } },
      base: { ref: "main" },
    },
    comment: {
      id: 901,
      body,
      html_url: "https://github.com/neevai-labs/outrunner/pull/30#discussion_r901",
      author_association: "COLLABORATOR",
      user: { id: 7, login: "ada", type: "User" },
      path: "lib/auth.ts",
      line: 44,
      start_line: 40,
      side: "RIGHT",
      diff_hunk: "@@ -38,6 +38,9 @@\n const a = 1;\n+const cache = new Map();",
    },
  };
}

test("a mention is @outrunner, or the App's slug or bot login, as a whole name", () => {
  assert.deepEqual(mentionNames(SLUG), ["outrunner-connector[bot]", "outrunner-connector", "outrunner"]);
  for (const body of ["@outrunner fix it", "hey @Outrunner, fix it", "@outrunner-connector fix", "@outrunner-connector[bot] fix", "(@outrunner)"]) {
    assert.equal(mentionsOutrunner(body, SLUG), true, body);
  }
  for (const body of ["@outrunnerbot fix", "@outrunner-bot fix", "mail me at me@outrunner.dev", "outrunner fix", "see github.com/@outrunner"]) {
    assert.equal(mentionsOutrunner(body, SLUG), false, body);
  }
  // Without the slug, only @outrunner.
  assert.equal(mentionsOutrunner("@outrunner-connector fix"), false);
});

test("a mention quoted from an earlier comment, or in code, isn't one", () => {
  assert.equal(mentionsOutrunner("> @outrunner fix it\n\nI agree", SLUG), false);
  assert.equal(mentionsOutrunner("Run `@outrunner` like this", SLUG), false);
  assert.equal(mentionsOutrunner("```\n@outrunner fix\n```", SLUG), false);
  assert.equal(mentionsOutrunner("> earlier\n@outrunner now you", SLUG), true);
});

test("the mention is taken out of what was asked", () => {
  assert.equal(stripMentions("@outrunner-connector please  rename this", SLUG), "please rename this");
  assert.equal(stripMentions("@outrunner", SLUG), "");
});

test("[skip outrunner] and bots keep it out", () => {
  assert.equal(skipsOutrunner("@outrunner [Skip Outrunner] just a note"), true);
  assert.equal(isBot({ login: "outrunner-connector[bot]", type: "Bot" }), true);
  assert.equal(isBot({ login: "ci-runner[bot]", type: "User" }), true);
  assert.equal(isBot({ login: "ada", type: "User" }), false);
  assert.equal(readMention("issue_comment", issueComment({ body: "@outrunner fix [skip outrunner]" }), SLUG), "skip");
  assert.equal(readMention("issue_comment", issueComment({ user: { login: "outrunner-connector[bot]", type: "Bot" } }), SLUG), "bot");
  assert.equal(readMention("issue_comment", issueComment({ body: "no one asked" }), SLUG), "no_mention");
});

test("only a new comment is a mention: an edit isn't a new request", () => {
  assert.equal(readMention("issue_comment", issueComment({ action: "edited" }), SLUG), "action");
  assert.equal(readMention("issue_comment", issueComment({ action: "deleted" }), SLUG), "action");
  assert.equal(readMention("pull_request", issueComment(), SLUG), "action");
  assert.equal(readMention("issue_comment", { action: "created" }, SLUG), "unreadable");
});

test("an issue comment is read as on its issue, or on its pull request's conversation", () => {
  const onIssue = readMention("issue_comment", issueComment(), SLUG);
  assert.ok(typeof onIssue === "object");
  assert.equal(onIssue.target, "issue");
  assert.equal(onIssue.number, 12);
  assert.deepEqual(onIssue.comment, {
    id: 900,
    kind: "issue_comment",
    body: "@outrunner please look into this",
    url: "https://github.com/neevai-labs/outrunner/issues/12#issuecomment-900",
  });
  assert.deepEqual(onIssue.author, { id: 7, login: "ada", type: "User" });
  assert.equal(onIssue.line, null);
  assert.equal(onIssue.pull, null);
  const onPull = readMention("issue_comment", issueComment({ pull: true }), SLUG);
  assert.ok(typeof onPull === "object");
  assert.equal(onPull.target, "pull");
  // Its branches aren't in the event: read from GitHub after.
  assert.equal(onPull.pull, null);
  assert.equal(mentionKey(onPull), "mention:issue_comment:900");
});

test("a review comment is read with its file, lines and diff, and its pull request's branches", () => {
  const mention = readMention("pull_request_review_comment", reviewComment(), SLUG);
  assert.ok(typeof mention === "object");
  assert.equal(mention.target, "pull");
  assert.equal(mention.comment.kind, "review_comment");
  assert.deepEqual(mention.line, {
    path: "lib/auth.ts",
    line: 44,
    startLine: 40,
    side: "RIGHT",
    diffHunk: "@@ -38,6 +38,9 @@\n const a = 1;\n+const cache = new Map();",
  });
  assert.deepEqual(mention.pull, { headRef: "feature/login", headSha: SHA, baseRef: "main", fromFork: false });
  assert.equal(mentionKey(mention), "mention:review_comment:901");

  const fork = reviewComment();
  fork.pull_request.head.repo.full_name = "someone/outrunner";
  const fromFork = readMention("pull_request_review_comment", fork, SLUG);
  assert.ok(typeof fromFork === "object");
  assert.equal(fromFork.pull?.fromFork, true);
});

test("a follow-up carries who said it, where in the diff, and what", () => {
  const mention = readMention("pull_request_review_comment", reviewComment(), SLUG);
  assert.ok(typeof mention === "object");
  const block = commentBlock(mention, SLUG);
  assert.match(block, /^@ada commented on `lib\/auth\.ts`, lines 40-44 \(https:\/\/github\.com\/.*discussion_r901\):/);
  assert.match(block, /```diff\n@@ -38,6 \+38,9 @@\n const a = 1;\n\+const cache = new Map\(\);\n```/);
  assert.match(block, /\n> rename this$/);
  const prompt = followUpPrompt(mention, SLUG);
  assert.match(prompt, /^New on GitHub, on the pull request this session works on \(neevai-labs\/outrunner#30\):/);
  assert.match(prompt, /gh pr comment 30/);
});

test("a new session is told the issue, or the pull request and where to push", () => {
  const issue = readMention("issue_comment", issueComment(), SLUG);
  assert.ok(typeof issue === "object");
  const issuePrompt = startPrompt(issue, SLUG);
  assert.match(issuePrompt, /^@ada asked for you on GitHub, on issue neevai-labs\/outrunner#12 "Login is slow"/);
  assert.match(issuePrompt, /> It takes 5 seconds\./);
  assert.match(issuePrompt, /Closes #12/);
  assert.match(issuePrompt, /gh issue comment 12/);

  const pull = readMention("pull_request_review_comment", reviewComment(), SLUG);
  assert.ok(typeof pull === "object");
  const pullPrompt = startPrompt(pull, SLUG);
  assert.match(pullPrompt, /git push origin HEAD:feature\/login/);
  assert.match(pullPrompt, /don't open another pull request/);
  assert.doesNotMatch(pullPrompt, /Closes #/);
});

test("titles and replies", () => {
  assert.equal(mentionTitle({ repoFullName: "neevai-labs/outrunner", number: 12, title: "Login is slow", target: "issue" }), "outrunner#12: Login is slow");
  assert.equal(mentionTitle({ repoFullName: "a/b", number: 1, title: "x".repeat(200), target: "pull" }).length, 120);
  assert.match(replyText({ kind: "started", url: "https://app/workspaces/w1" }), /\(https:\/\/app\/workspaces\/w1\)/);
  assert.match(replyText({ kind: "sent", url: "https://app/workspaces/w1" }), /^Sent to the session/);
  assert.equal(replyText({ kind: "failed", reason: "No allowance left" }), "I couldn't start a session for this: No allowance left.");
  assert.match(replyText({ kind: "no_access", repoFullName: "a/b" }), /Roles & access/);
});
