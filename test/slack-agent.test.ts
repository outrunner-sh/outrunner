import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_TOOLS,
  type AgentSpec,
  filedCard,
  MAX_QUESTION_ROUNDS,
  parseAgentReply,
  REPLY_TOOL,
  SPEC_ACTIONS,
  specCard,
  specMarkdown,
  systemPrompt,
  transcript,
  workerPrompt,
} from "@/lib/slack/agent";

const spec: AgentSpec = {
  title: "Fix checkout button on mobile Safari",
  repo: "acme/web",
  problem: "Tapping Checkout does nothing on iPhone Safari.",
  acceptanceCriteria: ["Tapping Checkout on iPhone Safari opens the payment step", "An e2e test covers it"],
  outOfScope: ["Android"],
  prompt: "Fix the checkout button on mobile Safari.",
};

test("the thread becomes the model's conversation: the bot's turns, everyone else's with their names", () => {
  const names = new Map([["U1", "ana"], ["U2", "raj"]]);
  const chat = transcript(
    [
      { user: "U1", text: "<@UBOT> checkout is *broken* on mobile" },
      { user: "UBOT", text: "Which repo is it?" },
      { user: "U2", text: "acme/web" },
      { user: "U1", subtype: "channel_join", text: "ana joined" },
      { user: "U1", text: "   " },
    ],
    { userId: "UBOT" },
    names,
  );
  assert.deepEqual(chat, [
    { role: "user", content: "ana: checkout is **broken** on mobile" },
    { role: "assistant", content: "Which repo is it?" },
    { role: "user", content: "raj: acme/web" },
  ]);
});

test("a long thread keeps its newest messages, and starts on a user turn", () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ user: i % 2 ? "UBOT" : "U1", text: `${i} ${"x".repeat(1000)}` }));
  const chat = transcript(messages, { userId: "UBOT" }, new Map());
  assert.ok(chat.length < 40);
  assert.equal(chat[0].role, "user");
  assert.match(chat[chat.length - 1].content, /^39 /);
});

test("at the question limit, the system prompt says to propose", () => {
  const context = { repos: [{ fullName: "acme/web", description: null }], openItems: [{ key: "OR-3", title: "Dark mode" }] };
  assert.doesNotMatch(systemPrompt({ ...context, rounds: 0 }), /propose now/);
  assert.match(systemPrompt({ ...context, rounds: MAX_QUESTION_ROUNDS }), /propose now/);
  assert.match(systemPrompt({ ...context, rounds: 0 }), /acme\/web[\s\S]*OR-3: Dark mode/);
});

test("the model's answer is checked: asks need words, proposals need criteria, unknown repos are dropped", () => {
  assert.deepEqual(parseAgentReply('{"action":"ask","message":"Which repo?","spec":null,"research":null}', []), {
    action: "ask",
    message: "Which repo?",
  });
  assert.equal(parseAgentReply('{"action":"ask","message":" "}', []), null);
  assert.equal(parseAgentReply("not json", []), null);
  const raw = (s: Record<string, unknown>) =>
    JSON.stringify({ action: "propose", message: "Here it is", spec: { title: "T", repo: "acme/web", problem: "P", acceptance_criteria: ["A"], out_of_scope: [], prompt: "Do it", ...s } });
  const ok = parseAgentReply(raw({}), ["Acme/Web"]);
  assert.ok(ok?.action === "propose");
  assert.equal(ok.spec.repo, "Acme/Web");
  const unknown = parseAgentReply(raw({ repo: "evil/repo" }), ["acme/web"]);
  assert.ok(unknown?.action === "propose" && unknown.spec.repo === null);
  assert.equal(parseAgentReply(raw({ acceptance_criteria: [] }), ["acme/web"]), null);
  assert.equal(parseAgentReply(raw({ prompt: "" }), ["acme/web"]), null);
  assert.ok(parseAgentReply("```json\n" + raw({}) + "\n```", ["acme/web"]));
});

test("the worker's prompt always carries the item, its criteria, and the PR it must open", () => {
  const prompt = workerPrompt(spec, { key: "OR-42", url: "https://app/triage?item=1" });
  assert.match(prompt, /^Fix the checkout button on mobile Safari\./);
  assert.match(prompt, /This is OR-42 \(https:\/\/app\/triage\?item=1\)/);
  assert.match(prompt, /- An e2e test covers it/);
  assert.match(prompt, /must start with "Closes OR-42"/);
  assert.match(specMarkdown(spec), /\*\*Acceptance criteria\*\*\n- \[ \] Tapping Checkout/);
});

test("the card starts a session in the repository picked in its dropdown, and loses its buttons once filed", () => {
  const actions = (blocks: Record<string, unknown>[]) =>
    (blocks.find((b) => b.type === "actions")?.elements as { action_id: string; value: string }[] | undefined)?.map((e) => e.action_id);
  assert.deepEqual(actions(specCard(spec, "c1", ["acme/web", "acme/api"])), [SPEC_ACTIONS.fileStart, SPEC_ACTIONS.repo]);
  assert.deepEqual(actions(specCard({ ...spec, repo: null }, "c1")), [SPEC_ACTIONS.fileStart]);
  const picker = (specCard(spec, "c1", ["acme/api"]).find((b) => b.type === "actions")?.elements as { action_id: string; initial_option?: { value: string }; options?: unknown[] }[])[1];
  assert.equal(picker.initial_option?.value, "acme/web");
  assert.equal(picker.options?.length, 2);
  const filed = filedCard(spec, { key: "OR-42", url: "https://app/x", by: "@ana", started: true });
  assert.equal(actions(filed), undefined);
  assert.match(JSON.stringify(filed), /Filed as <https:\/\/app\/x\|OR-42> by @ana · starting a session/);
  // Text from the thread can't break out of the card's markup.
  assert.match(JSON.stringify(specCard({ ...spec, problem: "a <!channel> b" }, "c1")), /a &lt;!channel&gt; b/);
});

test("questions get answers or research; research needs one of the asker's repositories", () => {
  const raw = (o: Record<string, unknown>) => JSON.stringify({ message: "", spec: null, research: null, ...o });
  assert.deepEqual(parseAgentReply(raw({ action: "answer", message: "3 PRs merged" }), []), { action: "answer", message: "3 PRs merged" });
  assert.equal(parseAgentReply(raw({ action: "answer", message: "" }), []), null);
  assert.deepEqual(
    parseAgentReply(raw({ action: "research", message: "Looking", research: { repo: "ACME/web", question: "How does billing pause boxes?" } }), ["acme/web"]),
    { action: "research", message: "Looking", repo: "acme/web", question: "How does billing pause boxes?" },
  );
  // A repository the asker can't read: ask which instead of guessing.
  assert.deepEqual(
    parseAgentReply(raw({ action: "research", message: "", research: { repo: "secret/repo", question: "Q" } }), ["acme/web"]),
    { action: "ask", message: "Which repository should I look in?" },
  );
  assert.equal(parseAgentReply(raw({ action: "research", research: { repo: "acme/web", question: " " } }), ["acme/web"]), null);
});

test("the agent ends every turn with the reply tool, and has the read-only lookups", () => {
  assert.deepEqual(
    AGENT_TOOLS.map((t) => t.function.name),
    ["recent_work", "find_items", "item_status", "channel_settings", REPLY_TOOL],
  );
  assert.match(systemPrompt({ repos: [], openItems: [], rounds: 0 }), /calling the reply tool exactly once/);
});
