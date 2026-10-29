import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent, ContentBlock } from "@/lib/runtime/agent-protocol";
import { conversationNodes } from "@/lib/runtime/conversation-nodes";
import { between, messageTime, workedFor } from "@/lib/runtime/turn-timing";
import { echoUuid } from "@/lib/session/optimistic-echo";

const message = (role: "user" | "assistant", timestamp: string, content: ContentBlock[], uuid = `${role}-${timestamp}`): AgentEvent => ({
  t: "message",
  uuid,
  parentUuid: null,
  role,
  timestamp,
  content,
});
const prompt = (at: string) => message("user", at, [{ type: "text", text: "fix it" }]);
const said = (at: string) => message("assistant", at, [{ type: "text", text: "done" }]);

test("a turn's work reads as minutes and padded seconds", () => {
  assert.equal(workedFor(42_400), "Worked for 42s");
  assert.equal(workedFor(188_000), "Worked for 3m 08s");
  assert.equal(workedFor(3_725_000), "Worked for 1h 02m");
  assert.equal(between("2026-10-28T10:00:00Z", "2026-10-28T09:59:00Z"), null, "skew isn't negative work");
  assert.equal(between("nope", "2026-10-28T10:00:00Z"), null);
});

test("each turn that is over ends in how long the agent worked on it", () => {
  const events = [
    prompt("2026-10-28T10:00:00Z"),
    message("assistant", "2026-10-28T10:00:05Z", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
    message("user", "2026-10-28T10:02:00Z", [{ type: "tool_result", toolUseId: "t1", content: "ok" }]),
    said("2026-10-28T10:03:08Z"),
    prompt("2026-10-28T10:10:00Z"),
    said("2026-10-28T10:10:30Z"),
  ];
  const nodes = conversationNodes(events);
  assert.deepEqual(
    nodes.map((n) => n.kind),
    ["prompt", "tool", "prose", "worked", "prompt", "prose", "worked"],
  );
  const worked = nodes.filter((n) => n.kind === "worked");
  assert.deepEqual(worked.map((n) => n.kind === "worked" && [n.ms, n.at]), [
    [188_000, "2026-10-28T10:03:08Z"],
    [30_000, "2026-10-28T10:10:30Z"],
  ]);
  const first = nodes[0];
  assert.equal(first.kind === "prompt" && first.at, "2026-10-28T10:00:00Z");
  // The turn under way has no end yet.
  assert.equal(conversationNodes(events, { working: true }).filter((n) => n.kind === "worked").length, 1);
});

test("a prompt still on its way has no time, and starts no turn", () => {
  const echo = message("user", "2026-10-28T10:00:00Z", [{ type: "text", text: "next" }], echoUuid("p1"));
  const nodes = conversationNodes([prompt("2026-10-28T09:00:00Z"), said("2026-10-28T09:00:20Z"), echo]);
  assert.deepEqual(nodes.map((n) => n.kind), ["prompt", "prose", "worked", "prompt"]);
  const last = nodes[3];
  assert.equal(last.kind === "prompt" && last.at, undefined);
});

test("a message's time says the day only when it isn't today", () => {
  const now = new Date(2026, 9, 28, 15, 0);
  assert.equal(messageTime(new Date(2026, 9, 28, 14, 2).toISOString(), now), "14:02");
  assert.equal(messageTime(new Date(2026, 9, 26, 9, 5).toISOString(), now), "Mon 09:05");
  assert.equal(messageTime(new Date(2026, 9, 3, 9, 5).toISOString(), now), "Oct 3, 09:05");
  assert.equal(messageTime("nope", now), null);
});
