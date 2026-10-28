import assert from "node:assert/strict";
import { test } from "node:test";

import { archiveClosed, handleMention, type LinkedSession, type LoopDeps, readClosed } from "@/lib/github/loop";
import type { ServerSessionStart } from "@/lib/session/server-session";

const SLUG = "outrunner-connector";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function comment(over: { body?: string; pull?: boolean; association?: string; githubId?: number } = {}) {
  return {
    action: "created",
    installation: { id: 42 },
    repository: { full_name: "neevai-labs/outrunner" },
    issue: {
      number: 12,
      title: "Login is slow",
      body: "It takes 5 seconds.",
      html_url: `https://github.com/neevai-labs/outrunner/${over.pull ? "pull" : "issues"}/12`,
      ...(over.pull && { pull_request: {} }),
    },
    comment: {
      id: 900,
      body: over.body ?? "@outrunner please fix",
      html_url: "https://github.com/neevai-labs/outrunner/issues/12#issuecomment-900",
      author_association: over.association ?? "MEMBER",
      user: { id: over.githubId ?? 7, login: "ada", type: "User" },
    },
  };
}

type Calls = {
  claims: string[];
  released: string[];
  replies: string[];
  reactions: number[];
  sent: { ownerId: string; workspaceId: string; prompt: string }[];
  started: ServerSessionStart[];
  links: unknown[];
  archived: { userId: string; ids: readonly string[] }[];
  woken: string[];
  suspended: string[];
};

function fakeDeps(over: Partial<LoopDeps> & { sessions?: LinkedSession[]; sendable?: string[] } = {}): { deps: LoopDeps; calls: Calls } {
  const calls: Calls = { claims: [], released: [], replies: [], reactions: [], sent: [], started: [], links: [], archived: [], woken: [], suspended: [] };
  const claimed = new Set<string>();
  const deps: LoopDeps = {
    scope: async () => ({ orgId: "o1", projectId: "p1" }),
    claim: async (key) => {
      calls.claims.push(key);
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    release: async (key) => {
      calls.released.push(key);
      claimed.delete(key);
    },
    member: async (githubId) => (githubId === 7 ? "u1" : null),
    level: async () => "write",
    linkedSessions: async () => over.sessions ?? [],
    pullBranches: async () => ({ headRef: "feature/login", headSha: SHA, baseRef: "main", fromFork: false }),
    wakeAndSend: async (ownerId, workspaceId, prompt) => {
      if (!(over.sendable ?? []).includes(workspaceId)) return false;
      calls.sent.push({ ownerId, workspaceId, prompt });
      return true;
    },
    startServerSession: async (start) => {
      calls.started.push(start);
      await start.onCreated?.("w-new");
      return { workspaceId: "w-new", status: "ready" };
    },
    link: async (link, workspace) => {
      calls.links.push({ link, workspace });
    },
    react: async (_installation, _repo, c) => {
      calls.reactions.push(c.id);
    },
    reply: async (_installation, _repo, _mention, body) => {
      calls.replies.push(body);
    },
    sessionUrl: (id) => `https://app.test/workspaces/${id}`,
    archiveOnClose: async () => true,
    wake: async (_ownerId, workspaceId) => {
      calls.woken.push(workspaceId);
      return workspaceId !== "unwakeable";
    },
    suspend: async (_ownerId, workspaceId) => {
      calls.suspended.push(workspaceId);
      return true;
    },
    archiveServerSessions: async (userId, ids) => {
      calls.archived.push({ userId, ids });
      return ids.length;
    },
    ...over,
  };
  return { deps, calls };
}

test("a mention on a pull request with a session goes to that session, with 👀 and a link", async () => {
  const { deps, calls } = fakeDeps({ sessions: [{ id: "w1", ownerId: "u2", status: "ready" }], sendable: ["w1"] });
  assert.equal(await handleMention("issue_comment", comment({ pull: true }), deps, SLUG), "sent");
  assert.deepEqual(calls.reactions, [900]);
  // As the session's owner, whoever commented.
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].ownerId, "u2");
  assert.match(calls.sent[0].prompt, /> please fix/);
  assert.deepEqual(calls.replies, ["Sent to the session working on this: [open it in Outrunner](https://app.test/workspaces/w1)."]);
  assert.equal(calls.started.length, 0);
});

test("a session that can't take it is passed over for the next, then a new one", async () => {
  const { deps, calls } = fakeDeps({ sessions: [{ id: "gone", ownerId: "u2", status: "ready" }, { id: "w2", ownerId: "u3", status: "ready" }], sendable: ["w2"] });
  assert.equal(await handleMention("issue_comment", comment({ pull: true }), deps, SLUG), "sent");
  assert.equal(calls.sent[0].workspaceId, "w2");

  const none = fakeDeps({ sessions: [{ id: "gone", ownerId: "u2", status: "ready" }] });
  assert.equal(await handleMention("issue_comment", comment({ pull: true }), none.deps, SLUG), "started");
  assert.equal(none.calls.started.length, 1);
});

test("a mention on a pull request with no session starts one as the commenter, on its head", async () => {
  const { deps, calls } = fakeDeps();
  assert.equal(await handleMention("issue_comment", comment({ pull: true }), deps, SLUG), "started");
  const [start] = calls.started;
  assert.equal(start.userId, "u1");
  assert.equal(start.projectId, "p1");
  assert.equal(start.baseBranch, "feature/login");
  assert.equal(start.title, "outrunner#12: Login is slow");
  assert.match(start.prompt, /git push origin HEAD:feature\/login/);
  assert.deepEqual(calls.links, [
    {
      link: {
        projectId: "p1",
        target: "pull",
        number: 12,
        headRef: "feature/login",
        url: "https://github.com/neevai-labs/outrunner/pull/12",
        title: "Login is slow",
        baseRef: "main",
      },
      workspace: { id: "w-new", ownerId: "u1" },
    },
  ]);
  assert.deepEqual(calls.replies, ["On it: [follow the session in Outrunner](https://app.test/workspaces/w-new)."]);
});

test("a mention on an issue starts a session on the default branch", async () => {
  const { deps, calls } = fakeDeps();
  assert.equal(await handleMention("issue_comment", comment(), deps, SLUG), "started");
  assert.equal(calls.started[0].baseBranch, undefined);
  assert.match(calls.started[0].prompt, /Closes #12/);
});

test("a redelivery acts once", async () => {
  const { deps, calls } = fakeDeps();
  assert.equal(await handleMention("issue_comment", comment(), deps, SLUG), "started");
  assert.equal(await handleMention("issue_comment", comment(), deps, SLUG), "repeat");
  assert.equal(calls.started.length, 1);
  assert.equal(calls.replies.length, 1);
});

test("someone who isn't a member is told only if GitHub knows them on the repository", async () => {
  const member = fakeDeps();
  assert.equal(await handleMention("issue_comment", comment({ githubId: 99 }), member.deps, SLUG), "not_member");
  assert.equal(member.calls.replies.length, 1);
  assert.match(member.calls.replies[0], /only take requests from members/);
  assert.equal(member.calls.reactions.length, 0);

  const visitor = fakeDeps();
  assert.equal(await handleMention("issue_comment", comment({ githubId: 99, association: "NONE" }), visitor.deps, SLUG), "not_member");
  assert.equal(visitor.calls.replies.length, 0);
  assert.equal(visitor.calls.started.length, 0);
});

test("another member's session is steered only by those who may write; anyone else gets their own", async () => {
  const readOnly = fakeDeps({ level: async () => "read", sessions: [{ id: "w1", ownerId: "u2", status: "ready" }], sendable: ["w1"] });
  assert.equal(await handleMention("issue_comment", comment({ pull: true }), readOnly.deps, SLUG), "started");
  assert.equal(readOnly.calls.sent.length, 0);
  assert.equal(readOnly.calls.started[0].userId, "u1");

  // Their own session, read or not.
  const own = fakeDeps({ level: async () => "read", sessions: [{ id: "w1", ownerId: "u1", status: "ready" }], sendable: ["w1"] });
  assert.equal(await handleMention("issue_comment", comment({ pull: true }), own.deps, SLUG), "sent");
});

test("a member who can't read the repository steers nothing", async () => {
  const { deps, calls } = fakeDeps({ level: async () => null, sessions: [{ id: "w1", ownerId: "u2", status: "ready" }], sendable: ["w1"] });
  assert.equal(await handleMention("issue_comment", comment({ pull: true }), deps, SLUG), "no_access");
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.started.length, 0);
  assert.match(calls.replies[0], /can't start sessions on neevai-labs\/outrunner/);
});

test("bots, [skip outrunner], other repositories and plain comments are left alone", async () => {
  const { deps, calls } = fakeDeps();
  const bot = comment();
  bot.comment.user = { id: 7, login: "outrunner-connector[bot]", type: "Bot" };
  assert.equal(await handleMention("issue_comment", bot, deps, SLUG), "ignored");
  assert.equal(await handleMention("issue_comment", comment({ body: "@outrunner [skip outrunner]" }), deps, SLUG), "ignored");
  assert.equal(await handleMention("issue_comment", comment({ body: "thanks all" }), deps, SLUG), "ignored");
  const elsewhere = fakeDeps({ scope: async () => null });
  assert.equal(await handleMention("issue_comment", comment(), elsewhere.deps, SLUG), "ignored");
  assert.equal(calls.claims.length + elsewhere.calls.claims.length, 0);
});

test("a fork's pull request starts nothing, and says why", async () => {
  const { deps, calls } = fakeDeps({ pullBranches: async () => ({ headRef: "x", headSha: SHA, baseRef: "main", fromFork: true }) });
  assert.equal(await handleMention("issue_comment", comment({ pull: true }), deps, SLUG), "fork");
  assert.equal(calls.started.length, 0);
  assert.match(calls.replies[0], /fork/);
});

test("a session that doesn't start is said as such; one that throws first gives its claim back", async () => {
  const refused = fakeDeps({
    startServerSession: async () => ({ workspaceId: null, status: "refused", errorMessage: "Your model allowance is used up" }),
  });
  assert.equal(await handleMention("issue_comment", comment(), refused.deps, SLUG), "failed");
  assert.deepEqual(refused.calls.replies, ["I couldn't start a session for this: Your model allowance is used up."]);

  const broken = fakeDeps({
    member: async () => {
      throw new Error("database down");
    },
  });
  await assert.rejects(handleMention("issue_comment", comment(), broken.deps, SLUG), /database down/);
  assert.deepEqual(broken.calls.released, ["mention:issue_comment:900"]);
});

test("closing an issue or pull request is read with what it closed and when", () => {
  assert.deepEqual(
    readClosed("pull_request", {
      action: "closed",
      installation: { id: 42 },
      repository: { full_name: "neevai-labs/outrunner" },
      pull_request: { number: 30, closed_at: "2026-10-28T10:00:00Z", head: { ref: "feature/login" } },
    }),
    { installationId: 42, repoFullName: "neevai-labs/outrunner", target: "pull", number: 30, headRef: "feature/login", closedAt: "2026-10-28T10:00:00Z" },
  );
  assert.deepEqual(
    readClosed("issues", {
      action: "closed",
      installation: { id: 42 },
      repository: { full_name: "neevai-labs/outrunner" },
      issue: { number: 12, closed_at: "2026-10-28T10:00:00Z" },
    }),
    { installationId: 42, repoFullName: "neevai-labs/outrunner", target: "issue", number: 12, headRef: null, closedAt: "2026-10-28T10:00:00Z" },
  );
  assert.equal(readClosed("issues", { action: "opened", installation: { id: 42 }, repository: { full_name: "a/b" }, issue: { number: 1 } }), null);
});

function closedPull(closedAt = "2026-10-28T10:00:00Z") {
  return {
    action: "closed",
    installation: { id: 42 },
    repository: { full_name: "neevai-labs/outrunner" },
    pull_request: { number: 30, closed_at: closedAt, merged: true, head: { ref: "feature/login" } },
  };
}

test("a closed pull request archives its sessions, each as its owner, once per close", async () => {
  const sessions = [
    { id: "w1", ownerId: "u1", status: "ready" },
    { id: "w2", ownerId: "u2", status: "ready" },
    { id: "w3", ownerId: "u1", status: "ready" },
  ];
  const { deps, calls } = fakeDeps({ sessions });
  assert.equal(await archiveClosed("pull_request", closedPull(), deps), 3);
  assert.deepEqual(calls.archived, [
    { userId: "u1", ids: ["w1"] },
    { userId: "u2", ids: ["w2"] },
    { userId: "u1", ids: ["w3"] },
  ]);
  assert.equal(await archiveClosed("pull_request", closedPull(), deps), 0);
  // Reopened and closed again: another close.
  assert.equal(await archiveClosed("pull_request", closedPull("2026-10-29T10:00:00Z"), deps), 3);
});

test("a session asleep when its pull request closes is woken to be archived", async () => {
  const { deps, calls } = fakeDeps({
    sessions: [
      { id: "w1", ownerId: "u1", status: "suspended" },
      { id: "unwakeable", ownerId: "u1", status: "suspended" },
      { id: "w2", ownerId: "u1", status: "idle" },
    ],
  });
  assert.equal(await archiveClosed("pull_request", closedPull(), deps), 2);
  assert.deepEqual(calls.woken, ["w1", "unwakeable"]);
  // Side by side: in whatever order they finish.
  assert.deepEqual(calls.archived.flatMap((a) => a.ids).sort(), ["w1", "w2"]);
  assert.deepEqual(calls.suspended, []);
});

test("one owner's sleeping sessions are woken one at a time, as they count against one plan", async () => {
  let awake = 0;
  let most = 0;
  const { deps } = fakeDeps({
    sessions: [
      { id: "a1", ownerId: "u1", status: "suspended" },
      { id: "a2", ownerId: "u1", status: "suspended" },
      { id: "b1", ownerId: "u2", status: "suspended" },
    ],
    wake: async () => {
      awake++;
      most = Math.max(most, awake);
      await new Promise((resolve) => setTimeout(resolve, 5));
      awake--;
      return true;
    },
  });
  assert.equal(await archiveClosed("pull_request", closedPull(), deps), 3);
  // u1's two one after the other, alongside u2's.
  assert.equal(most, 2);
});

test("a session woken to archive that then isn't is put back to sleep; one mid another step is left", async () => {
  const { deps, calls } = fakeDeps({
    sessions: [
      { id: "w1", ownerId: "u1", status: "suspended" },
      { id: "w2", ownerId: "u1", status: "resuming" },
    ],
    archiveServerSessions: async () => 0,
  });
  assert.equal(await archiveClosed("pull_request", closedPull(), deps), 0);
  assert.deepEqual(calls.woken, ["w1"]);
  assert.deepEqual(calls.suspended, ["w1"]);
});

test("an org that turned archiving on close off keeps its sessions", async () => {
  const { deps, calls } = fakeDeps({ sessions: [{ id: "w1", ownerId: "u1", status: "ready" }], archiveOnClose: async () => false });
  assert.equal(await archiveClosed("pull_request", closedPull(), deps), 0);
  assert.equal(calls.archived.length, 0);
  assert.equal(calls.claims.length, 0);
});
