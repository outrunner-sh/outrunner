/**
 * A thread with two requests, two Ships and three pull requests
 * (lib/missions/slack-announce.ts): each pull request's cards (opened, ready,
 * merged, closed) are its own, attributed to its Ship, keyed apart, told once
 * each however often the news comes; nothing assumes one pull request a
 * thread. Cards go under the binding the Ship started under.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { eventKey, type PullRequestRef } from "@/lib/missions/events";
import { cardEndText, closedBlocks } from "@/lib/missions/slack-text";
import { announcePullRequest, announceShipEvent, announceWaiting, type AnnounceDeps, cardKey } from "@/lib/missions/slack-announce";
import type { QueuedPost } from "@/lib/missions/slack-outbox";
import type { MissionChannel, MissionThread, ShipLedger } from "@/lib/missions/slack-store";

const thread: MissionThread = {
  id: "t1",
  missionId: "m1",
  teamId: "T1",
  channelId: "C1",
  threadTs: "1731400000.000100",
  permalink: null,
  startedBy: "ana",
  startedBySlack: "UANA",
  lastRequestTs: "1731400010.000100",
  muted: false,
};
const binding: MissionChannel = { missionId: "m1", orgId: "o1", teamId: "T1", channelId: "C1", boundBy: "wes", listen: "mentions", allowBotMessages: false, paused: false, revision: "rev1" };

function world() {
  const ledgers: Record<string, ShipLedger> = {
    // Ana's request: the login fix, with a stacked follow-up.
    r1: { requestKey: "Ev1", requestedBy: "ana", bindingRevision: "rev1", thread },
    // Bo's request, in the same thread: the docs.
    r2: { requestKey: "Ev2", requestedBy: "bo", bindingRevision: "rev1", thread },
  };
  const queue = new Map<string, QueuedPost>();
  const deps: AnnounceDeps = {
    ledger: async (runnerId) => ledgers[runnerId] ?? null,
    binding: async () => binding,
    latestThread: async () => thread,
    latestRequest: async () => ({ missionId: "m1", requestKey: "Ev2", threadId: "t1", bindingRevision: "rev1", messageTs: "1731400010.000100", requestedBy: "bo", requestedBySlack: "UBO" }),
    queue: async (post) => {
      if (queue.has(post.opKey)) return "already_pending";
      queue.set(post.opKey, post);
      return "queued";
    },
  };
  return { deps, queue, ledgers };
}

const pr1: PullRequestRef = { repo: "acme/web", number: 11, url: "https://github.com/acme/web/pull/11", title: "Fix login" };
const pr2: PullRequestRef = { repo: "acme/web", number: 12, url: "https://github.com/acme/web/pull/12", title: "Login tests" };
const pr3: PullRequestRef = { repo: "acme/docs", number: 11, url: "https://github.com/acme/docs/pull/11", title: "Docs" };

test("2 Ships and 3 pull requests in one thread: every card its own, once", async () => {
  const { deps, queue } = world();
  const opened = (runnerId: string, pr: PullRequestRef, ship: string) => announcePullRequest({ missionId: "m1", runnerId, kind: "opened", pr, ship }, deps);
  const event = (runnerId: string, kind: "ready" | "merged" | "closed" | "needs_attention", pr: PullRequestRef, ship: string, seq = 1) =>
    announceShipEvent(
      {
        missionId: "m1",
        runnerId,
        kind,
        payload: { runner: ship, pr },
        key: kind === "ready" || kind === "needs_attention" ? eventKey.decision(runnerId, pr, seq) : eventKey.ended(kind, runnerId, pr),
      },
      deps,
    );

  assert.equal(await opened("r1", pr1, "login-fix"), true);
  assert.equal(await opened("r1", pr2, "login-fix"), true);
  assert.equal(await opened("r2", pr3, "docs"), true);
  // Seen open again (another webhook): nothing new.
  assert.equal(await opened("r1", pr1, "login-fix"), false);
  assert.equal(await event("r1", "ready", pr1, "login-fix"), true);
  assert.equal(await event("r2", "ready", pr3, "docs"), true);
  // Not a card: the Mission handles it.
  assert.equal(await event("r1", "needs_attention", pr2, "login-fix", 1), false);
  // Ready again after a new head: a decision of its own.
  assert.equal(await event("r1", "ready", pr1, "login-fix", 2), true);
  assert.equal(await event("r1", "merged", pr1, "login-fix"), true);
  assert.equal(await event("r1", "closed", pr2, "login-fix"), true);
  assert.equal(await event("r2", "merged", pr3, "docs"), true);
  // Redelivered: told once.
  assert.equal(await event("r1", "merged", pr1, "login-fix"), false);

  const cards = [...queue.values()];
  assert.deepEqual(
    cards.map((c) => (c.payload as { chunks: string[] }).chunks[0]),
    [
      ":arrow_heading_up: Opened: <https://github.com/acme/web/pull/11|#11 Fix login> (Ship login-fix)",
      ":arrow_heading_up: Opened: <https://github.com/acme/web/pull/12|#12 Login tests> (Ship login-fix)",
      ":arrow_heading_up: Opened: <https://github.com/acme/docs/pull/11|#11 Docs> (Ship docs)",
      ":white_check_mark: Ready for review: <https://github.com/acme/web/pull/11|#11 Fix login> (Ship login-fix)",
      ":white_check_mark: Ready for review: <https://github.com/acme/docs/pull/11|#11 Docs> (Ship docs)",
      ":white_check_mark: Ready for review: <https://github.com/acme/web/pull/11|#11 Fix login> (Ship login-fix)",
      ":rocket: Merged: <https://github.com/acme/web/pull/11|#11 Fix login> (Ship login-fix)",
      ":no_entry_sign: Closed without merging: <https://github.com/acme/web/pull/12|#12 Login tests> (Ship login-fix)",
      ":rocket: Merged: <https://github.com/acme/docs/pull/11|#11 Docs> (Ship docs)",
    ],
  );
  // Same number in two repositories, two pull requests of one Ship: keyed apart.
  assert.notEqual(cardKey("opened", "r1", pr1), cardKey("opened", "r2", pr3));
  assert.equal(new Set(cards.map((c) => c.opKey)).size, 9);
  // All in the one thread, each checked against its own requester.
  assert.ok(cards.every((c) => c.threadTs === thread.threadTs && c.bindingRevision === "rev1"));
  assert.deepEqual([...new Set(cards.map((c) => `${c.opKey.split(":")[2]}:${c.requester}`))], ["r1:ana", "r2:bo"]);
});

test("cards go under the Ship's own binding (so a rebind drops them), never a muted thread or a Ship with no thread", async () => {
  const { deps, queue, ledgers } = world();
  ledgers.r1 = { ...ledgers.r1, bindingRevision: "rev-old" };
  await announcePullRequest({ missionId: "m1", runnerId: "r1", kind: "opened", pr: pr1, ship: "s" }, deps);
  assert.equal([...queue.values()][0].bindingRevision, "rev-old");
  ledgers.r2 = { ...ledgers.r2, thread: { ...thread, muted: true } };
  assert.equal(await announcePullRequest({ missionId: "m1", runnerId: "r2", kind: "opened", pr: pr3, ship: "s" }, deps), false);
  assert.equal(await announcePullRequest({ missionId: "m1", runnerId: "r9", kind: "opened", pr: pr3, ship: "s" }, deps), false);
  // Another Mission's Ship in this thread's ledger: not this Mission's to tell.
  assert.equal(await announcePullRequest({ missionId: "m2", runnerId: "r1", kind: "opened", pr: pr2, ship: "s" }, deps), false);
});

test("a wait on the owner is told once a wait, in the latest thread", async () => {
  const { deps, queue } = world();
  assert.equal(await announceWaiting("m1", "n1", "https://outrunner.example.com/workspaces/m1", deps), true);
  assert.equal(await announceWaiting("m1", "n1", "https://outrunner.example.com/workspaces/m1", deps), false);
  assert.equal(await announceWaiting("m1", "n2", null, deps), true);
  const [first] = queue.values();
  assert.equal(first.requester, "bo");
  assert.match((first.payload as { chunks: string[] }).chunks[0], /<https:\/\/outrunner\.example\.com\/workspaces\/m1\|answer in Outrunner>/);
});

test("a closed card names why nothing waits on it, with no buttons", () => {
  for (const why of ["off_call", "archived"] as const) {
    const blocks = closedBlocks("Which env?", why);
    assert.equal(JSON.stringify(blocks).includes('"button"'), false);
    assert.equal(blocks.length, 2);
    assert.match(JSON.stringify(blocks[1]), why === "archived" ? /was archived/ : /went off call/);
    assert.match(cardEndText(why), /^No longer waiting: the Mission /);
  }
});
