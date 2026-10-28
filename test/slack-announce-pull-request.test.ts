import assert from "node:assert/strict";
import { test } from "node:test";

import type { SlackConversation } from "@/lib/db/slack-agent";
import { type AnnounceDeps, announcePullRequestWith } from "@/lib/slack/announce-pull-request";

const opened = { repoFullName: "acme/api", headRef: "outrunner/fix-login", number: 12, url: "https://github.com/acme/api/pull/12", title: "Fix <login>" };

/** The thread of OR-7, its session on the PR's branch, with the claim as the
 *  database makes it: once per PR. */
function thread() {
  const followed = new Map<string, string>();
  const posts: string[] = [];
  const deps: AnnounceDeps = {
    sessionsOn: async (repo, branch) => (repo === "acme/api" && branch === opened.headRef ? ["ws-1"] : []),
    itemsOf: async (ids) => (ids.includes("ws-1") ? [{ id: "item-7", number: 7 }] : []),
    conversationForItem: async (id) => (id === "item-7" ? ({ id: "conv-1" } as SlackConversation) : null),
    claim: async (id, pr) => {
      const key = `${pr.repo}#${pr.number}`;
      if (followed.get(id) === key) return false;
      followed.set(id, key);
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
  await announcePullRequestWith({ ...opened, repoFullName: "acme/web" }, deps);
  assert.deepEqual(posts, []);
});
