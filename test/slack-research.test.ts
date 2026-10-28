import assert from "node:assert/strict";
import { test } from "node:test";

import { hashToken, markdownToSlack, researchPrompt, slackChunks } from "@/lib/slack/research-text";

test("the research prompt changes nothing and answers through its own link, once", () => {
  const prompt = researchPrompt({ question: "How are idle boxes paused?", url: "https://app/api/integrations/slack/research/1", token: "tok_123" });
  assert.match(prompt, /^A teammate asked this in a Slack thread/);
  assert.match(prompt, /How are idle boxes paused\?/);
  assert.match(prompt, /Don't change, commit or push anything/);
  assert.match(prompt, /curl -sS -X POST 'https:\/\/app\/api\/integrations\/slack\/research\/1' -H 'Authorization: Bearer tok_123'/);
  assert.equal(hashToken("tok_123").length, 64);
});

test("an answer's Markdown becomes Slack's markup, code left alone", () => {
  assert.equal(
    markdownToSlack("## Short answer\n**Yes**, see [billing.ts](https://github.com/a/b/blob/x/billing.ts#L10).\n```ts\nconst a = **b**;\n```"),
    "*Short answer*\n*Yes*, see <https://github.com/a/b/blob/x/billing.ts#L10|billing.ts>.\n```ts\nconst a = **b**;\n```",
  );
});

test("a long answer is split at paragraphs into Slack-sized messages", () => {
  const paragraph = "word ".repeat(300).trim();
  const chunks = slackChunks(Array.from({ length: 6 }, () => paragraph).join("\n\n"), 3900);
  assert.ok(chunks.length > 1 && chunks.length <= 5);
  assert.ok(chunks.every((c) => c.length <= 3900));
  assert.deepEqual(slackChunks("short"), ["short"]);
});
