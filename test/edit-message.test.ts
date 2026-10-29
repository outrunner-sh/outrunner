import assert from "node:assert/strict";
import { test } from "node:test";

import { conversationFrom } from "@/lib/api/conversation";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { appendEvent, rewound } from "@/lib/runtime/conversation-events";
import { conversationNodes } from "@/lib/runtime/conversation-nodes";
import { echoUuid } from "@/lib/session/optimistic-echo";

const message = (role: "user" | "assistant", uuid: string, text: string): AgentEvent => ({
  t: "message",
  uuid,
  parentUuid: null,
  role,
  timestamp: "2026-10-29T10:00:00Z",
  content: [{ type: "text", text }],
});
const prompt = (uuid: string, text: string) => message("user", uuid, text);
const reply = (uuid: string, text: string) => message("assistant", uuid, text);
const state: AgentEvent = { t: "state", workspaceId: "ws", state: "running" };

test("an edit's cut drops its prompt and all after it, keeping the session's state", () => {
  const events = [state, prompt("u1", "one"), reply("a1", "done"), prompt("u2", "two"), reply("a2", "also")];
  assert.deepEqual(
    rewound(events, "u2").map((e) => (e.t === "message" ? e.uuid : e.t)),
    ["state", "u1", "a1"],
  );
  assert.equal(rewound(events, "gone"), events, "a prompt this page never had cuts nothing");
});

test("the stream's rewind lets go of the ids past the cut, which it sends again", () => {
  const seen = new Set(["100", "200", "300"]);
  const events = [prompt("u1", "one"), prompt("u2", "two")];
  const after = appendEvent(events, { t: "rewind", at: 150, uuid: "u2", rewinds: 1 }, "150", seen);
  assert.deepEqual(after.map((e) => (e.t === "message" ? e.uuid : e.t)), ["u1"]);
  assert.deepEqual([...seen], ["100"]);
});

test("the API's reading of a stream takes an edit's cut in", () => {
  const frame = (id: string, event: unknown) => ({ id, data: JSON.stringify(event) });
  const { entries } = conversationFrom([
    frame("10", prompt("u1", "one")),
    frame("20", prompt("u2", "two")),
    frame("30", reply("a2", "also")),
    frame("10", { t: "rewind", at: 10, uuid: "u2", rewinds: 1 }),
    frame("25", prompt("u3", "two, edited")),
  ]);
  assert.deepEqual(
    entries.map((e) => [e.id, e.event.t === "message" ? e.event.uuid : e.event.t]),
    [
      [10, "u1"],
      [25, "u3"],
    ],
  );
});

test("a prompt in the log can be edited; its echo, not yet there, can't", () => {
  const nodes = conversationNodes([prompt("u1", "one"), reply("a1", "done"), prompt(echoUuid("p"), "on its way")]);
  const prompts = nodes.filter((n) => n.kind === "prompt");
  assert.equal(prompts[0].kind === "prompt" && prompts[0].uuid, "u1");
  assert.equal(prompts[1].kind === "prompt" && prompts[1].uuid, undefined);
});

test("an unknown-cut reset discards stale history and all seen IDs", () => {
  const seen = new Set(["100", "200"]);
  assert.deepEqual(appendEvent([state, prompt("old", "obsolete")], { t: "rewind", at: 0, uuid: "", rewinds: 0, reset: true }, "0", seen), [state]);
  assert.equal(seen.size, 0);
  const { entries } = conversationFrom([
    { id: "100", data: JSON.stringify(prompt("old", "obsolete")) },
    { id: "0", data: JSON.stringify({ t: "rewind", at: 0, uuid: "", rewinds: 0, reset: true }) },
    { id: "100", data: JSON.stringify(prompt("new", "restored")) },
  ]);
  assert.deepEqual(entries.map((item) => item.event.t === "message" && item.event.uuid), ["new"]);
});

test("editing a files-only prompt cannot resend the raw attachment header", async () => {
  const { editPromptText } = await import("@/lib/session/edit-message");
  const { promptWithAttachments } = await import("@/lib/runtime/attachments");
  assert.equal(editPromptText(promptWithAttachments("", ["a.png"])), "");
  assert.equal(editPromptText(promptWithAttachments("Look here", ["a.png"])), "Look here");
});
