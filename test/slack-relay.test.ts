import assert from "node:assert/strict";
import { test } from "node:test";

import { fromThread, QUIET_MS, replyChunks, turnOver } from "@/lib/slack/relay-text";

test("a thread message tells the session who said it, and where", () => {
  assert.equal(fromThread("ana", "also check Firefox"), "ana (in the Slack thread): also check Firefox");
});

test("a turn is over once there's a reply and the session has gone quiet", () => {
  const now = Date.parse("2026-10-29T10:00:00Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(turnOver({ lastAssistantMessage: "Done: PR #12", lastActivity: at(QUIET_MS + 1) }, now), true);
  assert.equal(turnOver({ lastAssistantMessage: "Working…", lastActivity: at(5_000) }, now), false);
  assert.equal(turnOver({ lastAssistantMessage: null, lastActivity: at(60_000) }, now), false);
  assert.equal(turnOver({ lastAssistantMessage: "x", lastActivity: "not a date" }, now), false);
});

test("the reply is posted in Slack's markup, with a link to the whole session", () => {
  const chunks = replyChunks("**Fixed** it: see [PR #12](https://github.com/a/b/pull/12)", "https://app/workspaces/1");
  assert.deepEqual(chunks, ["*Fixed* it: see <https://github.com/a/b/pull/12|PR #12>\n\n<https://app/workspaces/1|Open the session>"]);
  const long = replyChunks(Array.from({ length: 4 }, () => "word ".repeat(400).trim()).join("\n\n"), "https://app/w");
  assert.ok(long.length > 1 && long.at(-1)?.endsWith("<https://app/w|Open the session>"));
});
