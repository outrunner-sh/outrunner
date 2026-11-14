/**
 * "Ask about this PR": a question about one pull request, answered from its
 * code by Outrunner's model on the org's budget (orgModelKey). The model reads
 * what it needs through read-only tools: the files changed, a file's diff, a
 * file at the PR's head, the PR's comments.
 */

import { agentModel } from "@/lib/slack/agent-model";
import { githubGet } from "@/lib/github/rest";

const COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_ROUNDS = 6;
/** Room for the model's reasoning as well as its answer: the default model
 *  thinks before it writes, and a cap that thinking fills leaves no answer. */
const MAX_TOKENS = 8000;

/** OpenRouter refused the call: `status` says why (401 a bad key, 402 no
 *  credits left, 403 a key's limit reached). */
export class ModelCallError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`The model call failed (${status}): ${detail}`);
    this.name = "ModelCallError";
    this.status = status;
  }
}

export type AskMessage = { role: "user" | "assistant"; content: string };

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Message =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string | null; tool_calls: ToolCall[]; reasoning_details?: unknown }
  | { role: "tool"; tool_call_id: string; content: string };

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "The files this pull request changes: path, status, lines added and removed.",
      parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "file_diff",
      description: "The diff (patch) of one changed file in this pull request.",
      parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "A file's content at the pull request's head commit (any file in the repository, for context).",
      parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "list_comments",
      description: "The pull request's conversation: comments and reviews, newest first.",
      parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
    },
  },
] as const;

export type PullContext = {
  token: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  headSha: string;
  baseRef: string;
  headRef: string;
};

function systemPrompt(pr: PullContext): string {
  return `You answer questions about pull request #${pr.number} in ${pr.repo}: "${pr.title}" (${pr.headRef} → ${pr.baseRef}).

Its description:
${pr.body.slice(0, 6000) || "(none)"}

Read the change with the tools before you answer: list_files, then file_diff for what matters, and read_file for surrounding code. Answer from the code, never from guesses: name files and functions, quote short lines where it helps. Be direct and brief (a few short paragraphs or a list). Say plainly when something can't be told from the code.`;
}

type FileEntry = { filename: string; status: string; additions: number; deletions: number; patch?: string };

/** The read-only tools, on the GitHub App's token for the PR's repository. */
function lookups(pr: PullContext) {
  let files: FileEntry[] | null = null;
  const changed = async () => (files ??= (await githubGet<FileEntry[]>(pr.token, `/repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`)) ?? []);
  return {
    list_files: async () =>
      JSON.stringify((await changed()).map((f) => ({ path: f.filename, status: f.status, added: f.additions, removed: f.deletions }))),
    file_diff: async (args: Record<string, unknown>) => {
      const file = (await changed()).find((f) => f.filename === args.path);
      return file ? (file.patch ?? "(binary or too large to show)").slice(0, 30_000) : JSON.stringify({ error: "Not a file this PR changes." });
    },
    read_file: async (args: Record<string, unknown>) => {
      const path = typeof args.path === "string" ? args.path.replace(/^\/+/, "") : "";
      if (!path || path.includes("..")) return JSON.stringify({ error: "Give a path in the repository." });
      const file = await githubGet<{ content?: string; encoding?: string }>(
        pr.token,
        `/repos/${pr.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${pr.headSha}`,
      );
      if (!file?.content) return JSON.stringify({ error: "No such file at the PR's head." });
      return Buffer.from(file.content, (file.encoding as BufferEncoding) ?? "base64").toString("utf8").slice(0, 40_000);
    },
    list_comments: async () => {
      const [comments, reviews] = await Promise.all([
        githubGet<{ user?: { login?: string }; body?: string }[]>(pr.token, `/repos/${pr.repo}/issues/${pr.number}/comments?sort=created&direction=desc&per_page=30`),
        githubGet<{ user?: { login?: string }; state?: string; body?: string }[]>(pr.token, `/repos/${pr.repo}/pulls/${pr.number}/reviews?per_page=30`),
      ]);
      return JSON.stringify({
        comments: (comments ?? []).map((c) => ({ by: c.user?.login, body: (c.body ?? "").slice(0, 2000) })),
        reviews: (reviews ?? []).map((r) => ({ by: r.user?.login, state: r.state, body: (r.body ?? "").slice(0, 1000) })),
      }).slice(0, 30_000);
    },
  } as Record<string, (args: Record<string, unknown>) => Promise<string>>;
}

/** An answer to the conversation's last question, in Markdown. */
export async function askAboutPull(key: string, pr: PullContext, conversation: AskMessage[]): Promise<string> {
  const tools = lookups(pr);
  const messages: Message[] = [{ role: "system", content: systemPrompt(pr) }, ...conversation.slice(-12)];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS - 1;
    // The tools stay defined on the last round (a conversation with tool
    // calls in it needs them), but may no longer be called.
    if (last) messages.push({ role: "user", content: "That's enough reading: answer now from what you have." });
    const response = await fetch(COMPLETIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Outrunner Review" },
      body: JSON.stringify({
        model: agentModel(),
        messages,
        tools: TOOLS,
        tool_choice: last ? "none" : "auto",
        reasoning: { effort: "low" },
        max_tokens: MAX_TOKENS,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await response.json().catch(() => null)) as {
      choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: ToolCall[]; reasoning_details?: unknown } }[];
      error?: { message?: string };
    } | null;
    if (!response.ok) throw new ModelCallError(response.status, body?.error?.message ?? "no detail");
    const message = body?.choices?.[0]?.message;
    const calls = last ? [] : (message?.tool_calls ?? []);
    if (calls.length === 0) {
      const text = message?.content?.trim();
      if (text) return text;
      console.error(`Review: the model wrote no answer (finish: ${body?.choices?.[0]?.finish_reason ?? "unknown"})`);
      return "I couldn't come up with an answer. Try asking another way.";
    }
    // Its reasoning goes back with its tool calls, as Claude expects when
    // it thinks between them.
    messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: calls, reasoning_details: message?.reasoning_details });
    for (const call of calls) {
      let result: string;
      try {
        const run = tools[call.function.name];
        result = run ? await run(JSON.parse(call.function.arguments || "{}") as Record<string, unknown>) : JSON.stringify({ error: "No such tool." });
      } catch {
        result = JSON.stringify({ error: "That lookup failed." });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  return "I read a lot but couldn't finish an answer. Try a narrower question.";
}
