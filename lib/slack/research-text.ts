/**
 * A Slack thread's research, the parts with no network or database: what the
 * research session is told, and how its answer is posted in the thread
 * (lib/slack/research.ts runs it).
 */

import { createHash } from "node:crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * What the research session is told: answer the question from the code,
 * change nothing, and post the answer through its link. The link and token
 * are this question's alone and work once.
 */
export function researchPrompt(input: { question: string; url: string; token: string }): string {
  return `A teammate asked this in a Slack thread, about this repository:

${input.question}

Answer it from the code. Read the source, the git history and the tests, and run read-only commands where that helps. Don't change, commit or push anything.

Write the answer for Slack: lead with the direct answer in a sentence or two, then the evidence (file paths with line numbers, commits, command output), at most about 400 words. Plain Markdown, no headings.

When it's ready, post it with exactly these two steps (once; if the second fails, try it once more):

cat > /tmp/outrunner-answer.md <<'OUTRUNNER_ANSWER'
<your answer>
OUTRUNNER_ANSWER

curl -sS -X POST '${input.url}' -H 'Authorization: Bearer ${input.token}' -H 'Content-Type: text/markdown' --data-binary @/tmp/outrunner-answer.md`;
}

/** Markdown as Slack's markup, for the answer posted in the thread. */
export function markdownToSlack(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
            .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
            .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>"),
    )
    .join("");
}

/** A long answer split where Slack allows (about 3,900 characters a message),
 *  at paragraph breaks where it can. */
export function slackChunks(text: string, max = 3900): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.slice(0, 5);
}
