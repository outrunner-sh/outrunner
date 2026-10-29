import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CHAT_PREFERENCES, followUpRoute, steers } from "@/lib/session/chat-preferences";
import { parseCommentQuotes, withComments } from "@/lib/session/diff-comments";
import { editQueued, moveQueued, type QueuedPrompt } from "@/lib/session/prompt-queue";

const queued = (id: string, text: string, attachmentIds: string[] = []): QueuedPrompt => ({ id, text, attachmentIds });

test("a queued prompt's words change, the comments on the diff it carries stay", () => {
  const quote = { path: "a.ts", side: "new" as const, startLine: 3, endLine: 4, code: "x()", comment: "why?" };
  const queue = [queued("1", withComments("fix it", [quote])), queued("2", "next")];
  const edited = editQueued(queue, "1", "  fix it properly ");
  assert.deepEqual(parseCommentQuotes(edited[0].text), { text: "fix it properly", quotes: [quote] });
  assert.equal(edited[1], queue[1], "the others are left alone");
  // Emptied, with nothing else to send: kept as it was rather than sent as nothing.
  assert.equal(editQueued([queued("3", "hi")], "3", "  ")[0].text, "hi");
  assert.equal(editQueued([queued("4", "hi", ["file"])], "4", "")[0].text, "", "files alone still send");
});

test("a queued prompt moves within the queue", () => {
  const queue = ["a", "b", "c"].map((id) => queued(id, id));
  const ids = (q: QueuedPrompt[]) => q.map((p) => p.id).join("");
  assert.equal(ids(moveQueued(queue, "c", -1)), "acb");
  assert.equal(ids(moveQueued(queue, "a", 1)), "bac");
  assert.equal(moveQueued(queue, "a", -1), queue, "the first can't go sooner");
  assert.equal(moveQueued(queue, "c", 1), queue, "the last can't go later");
  assert.equal(moveQueued(queue, "z", 1), queue);
});

test("a follow-up mid-turn steers Claude by default, and queues when steering is off", () => {
  assert.equal(DEFAULT_CHAT_PREFERENCES.steerFollowUps, true);
  const route = (over: Partial<Parameters<typeof followUpRoute>[0]>) =>
    followUpRoute({ working: true, queued: 0, steerFollowUps: true, agent: "claude", ...over });
  assert.equal(route({}), "steer");
  assert.equal(route({ queued: 2 }), "steer", "ahead of what waits");
  assert.equal(route({ steerFollowUps: false }), "queue");
  assert.equal(route({ agent: "codex" }), "queue", "Codex's follow-ups queue");
  assert.equal(route({ working: false }), "send");
  assert.equal(route({ working: false, queued: 1 }), "queue", "behind what waits between turns");
  assert.equal(steers("claude") && !steers("codex"), true);
});
