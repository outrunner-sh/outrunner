import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { askAboutPull, ModelCallError, type PullContext } from "@/lib/review/ask";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PR: PullContext = { token: "gh", repo: "acme/app", number: 7, title: "A change", body: "", headSha: "abc", baseRef: "main", headRef: "feat" };

type Sent = { messages: { role: string; reasoning_details?: unknown }[]; tools?: unknown[]; tool_choice?: string; max_tokens: number };

/** OpenRouter answering each round with `answer(round)`, and GitHub with an
 *  empty file list; the model calls are recorded. */
function stub(answer: (round: number) => Response) {
  const sent: Sent[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).startsWith("https://api.github.com/")) return Promise.resolve(Response.json([]));
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return Promise.resolve(answer(sent.length - 1));
  }) as typeof fetch;
  return sent;
}

const toolCall = (round: number) =>
  Response.json({
    choices: [
      {
        finish_reason: "tool_calls",
        message: { content: null, reasoning_details: [{ type: "reasoning.text", text: `thought ${round}` }], tool_calls: [{ id: `c${round}`, type: "function", function: { name: "list_files", arguments: "{}" } }] },
      },
    ],
  });

test("leaves room for the model's reasoning as well as its answer", async () => {
  const sent = stub(() => Response.json({ choices: [{ message: { content: "Looks fine." } }] }));
  assert.equal(await askAboutPull("key", PR, [{ role: "user", content: "Can we merge?" }]), "Looks fine.");
  assert.ok(sent[0].max_tokens >= 8000);
});

test("sends each round's reasoning back with its tool calls", async () => {
  const sent = stub((round) => (round === 0 ? toolCall(0) : Response.json({ choices: [{ message: { content: "Done." } }] })));
  await askAboutPull("key", PR, [{ role: "user", content: "What changed?" }]);
  const assistant = sent[1].messages.find((m) => m.role === "assistant");
  assert.deepEqual(assistant?.reasoning_details, [{ type: "reasoning.text", text: "thought 0" }]);
});

test("on the last round, keeps the tools defined but asks for the answer", async () => {
  const sent = stub((round) => (round < 5 ? toolCall(round) : Response.json({ choices: [{ message: { content: "Here's what I found." } }] })));
  assert.equal(await askAboutPull("key", PR, [{ role: "user", content: "Review it all" }]), "Here's what I found.");
  assert.equal(sent.length, 6);
  const last = sent.at(-1)!;
  assert.ok(last.tools?.length, "a conversation with tool calls in it needs its tools defined");
  assert.equal(last.tool_choice, "none");
  assert.equal(last.messages.at(-1)?.role, "user");
});

test("a refusal from OpenRouter carries its status", async () => {
  stub(() => Response.json({ error: { message: "Insufficient credits" } }, { status: 402 }));
  await assert.rejects(askAboutPull("key", PR, [{ role: "user", content: "Can we merge?" }]), (error: unknown) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.status, 402);
    return true;
  });
});
