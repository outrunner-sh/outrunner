import assert from "node:assert/strict";
import { test } from "node:test";

import type { SlackConversation } from "@/lib/db/slack-agent";
import { type AnnounceDeps, announcePullRequestWith } from "@/lib/slack/announce-pull-request";

const opened = { repoId: 501, repoFullName: "acme/api", headRef: "outrunner/fix-login", number: 12, url: "https://github.com/acme/api/pull/12", title: "Fix <login>" };

/** The thread of OR-7, its session on the PR's branch, with the claim as the
 *  database makes it (claimPullRequest): once per PR, and never back to an
 *  older one of the same repository. */
function thread() {
  const followed = new Map<string, { repo: string; number: number }>();
  const posts: string[] = [];
  const deps: AnnounceDeps = {
    sessionsOn: async (repoId, branch) => (repoId === 501 && branch === opened.headRef ? ["ws-1"] : []),
    itemsOf: async (ids) => (ids.includes("ws-1") ? [{ id: "item-7", number: 7 }] : []),
    conversationForItem: async (id) => (id === "item-7" ? ({ id: "conv-1" } as SlackConversation) : null),
    claim: async (id, pr) => {
      const now = followed.get(id);
      if (now && now.repo === pr.repo && now.number >= pr.number) return false;
      followed.set(id, { repo: pr.repo, number: pr.number });
      return true;
    },
    post: async (_conversation, text) => void posts.push(text),
  };
  return { deps, posts };
}

test("an opened PR is told in its item's thread once, however often GitHub delivers it", async () => {
  const { deps, posts } = thread();
  await announcePullRequestWith(opened, deps);
  // A redelivery, and two copies at once.
  await announcePullRequestWith(opened, deps);
  await Promise.all([announcePullRequestWith(opened, deps), announcePullRequestWith(opened, deps)]);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /^Pull request for OR-7: <https:\/\/github\.com\/acme\/api\/pull\/12\|#12 Fix login>/);
});

test("a new PR on the thread, after one closed unmerged, is told too", async () => {
  const { deps, posts } = thread();
  await announcePullRequestWith(opened, deps);
  await announcePullRequestWith({ ...opened, number: 13, url: "https://github.com/acme/api/pull/13" }, deps);
  assert.equal(posts.length, 2);
});

test("a PR from a branch no session of an item is on is told nowhere", async () => {
  const { deps, posts } = thread();
  await announcePullRequestWith({ ...opened, headRef: "someone/else" }, deps);
  await announcePullRequestWith({ ...opened, repoId: 502, repoFullName: "acme/web" }, deps);
  assert.deepEqual(posts, []);
});

test("an older PR's event delivered late doesn't take the thread back from its successor", async () => {
  const { deps, posts } = thread();
  await announcePullRequestWith({ ...opened, number: 11, url: "https://github.com/acme/api/pull/11" }, deps);
  await announcePullRequestWith(opened, deps);
  // #11's opened, retried by GitHub after #12 replaced it.
  await announcePullRequestWith({ ...opened, number: 11, url: "https://github.com/acme/api/pull/11" }, deps);
  assert.equal(posts.length, 2);
  assert.match(posts[1], /#12/);
});

test("a post Slack refuses is logged, and the next thread is still told", async () => {
  const { deps, posts } = thread();
  const two: AnnounceDeps = {
    ...deps,
    itemsOf: async () => [
      { id: "item-7", number: 7 },
      { id: "item-8", number: 8 },
    ],
    conversationForItem: async (id) => ({ id: id === "item-7" ? "conv-1" : "conv-2" }) as SlackConversation,
    post: async (conversation, text) => {
      if (conversation.id === "conv-1") throw new Error("ratelimited");
      posts.push(text);
    },
  };
  const logged = console.error;
  console.error = () => undefined;
  try {
    await announcePullRequestWith(opened, two);
  } finally {
    console.error = logged;
  }
  assert.equal(posts.length, 1);
  assert.match(posts[0], /OR-8/);
});
