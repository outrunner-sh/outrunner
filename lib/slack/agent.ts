/**
 * The Slack agent, the parts with no network: what it's told, how a Slack
 * thread becomes its conversation, what it may answer (ask or propose), and
 * how a proposal becomes a spec card, a work item and a session prompt.
 *
 * It is the coordinator of a small mission: it talks with people until the
 * work is clear, writes what "done" means (acceptance criteria) before any
 * code exists, and hands a ready prompt to a worker session that a person
 * starts. A separate validator checks the result against those criteria.
 */

import { slackToMarkdown } from "@/lib/slack/slack";
import { titleFromText } from "@/lib/triage/work-items";

/** After this many rounds of questions it must propose. */
export const MAX_QUESTION_ROUNDS = 3;
/** The most of a thread the model is shown, newest kept. */
const MAX_TRANSCRIPT_CHARS = 16_000;

export type AgentSpec = {
  title: string;
  /** `owner/name` of one of the org's repositories, or null when unknown. */
  repo: string | null;
  problem: string;
  acceptanceCriteria: string[];
  outOfScope: string[];
  /** The prompt a worker session starts with (the footer is added on filing). */
  prompt: string;
};

export type AgentReply = { action: "ask"; message: string } | { action: "propose"; message: string; spec: AgentSpec };

export type AgentContext = {
  /** The org's repositories the agent may pick from. */
  repos: { fullName: string; description: string | null }[];
  /** Open work items, so it can say when one is already there. */
  openItems: { key: string; title: string }[];
  /** Question rounds so far: at the limit, it must propose. */
  rounds: number;
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export function systemPrompt(context: AgentContext): string {
  const repos = context.repos.length
    ? context.repos.map((r) => `- ${r.fullName}${r.description ? `: ${r.description}` : ""}`).join("\n")
    : "(none connected yet)";
  const items = context.openItems.length
    ? context.openItems.map((i) => `- ${i.key}: ${i.title}`).join("\n")
    : "(none)";
  const mustPropose = context.rounds >= MAX_QUESTION_ROUNDS;
  return `You are Outrunner, an engineering teammate in a Slack thread. Your job is intake: understand what the people in the thread need built or fixed, ask what you must, then write it up as a precise work item that a coding agent can carry out without asking anything else.

How to work:
- Read the whole thread. Several people may be talking; messages are prefixed with who wrote them.
- Ask only what changes the work: which repository, how to reproduce, expected vs actual behaviour, constraints, and what "done" means. Ask at most 3 short, specific questions at a time, numbered, and never ask what the thread already answers.
- Don't propose a design the people didn't ask for, and never invent facts about the codebase.
- When you know enough, propose. A proposal has: a short imperative title; the repository (exactly one of the names below, or null if the thread doesn't say and it isn't clear); the problem in a few sentences; acceptance criteria as checkable statements (each one something a reviewer can verify: a test that passes, a behaviour seen in the app, a command's output); what is out of scope; and the session prompt.
- The session prompt is for an autonomous coding agent working in the repository: state the goal, the context from the thread (quote specifics: error messages, URLs, steps), the acceptance criteria, and constraints. Write it so it stands alone. Don't include instructions about pull requests; they're added for you.
- If an open item below already covers the request, say so and give its key; still propose if the thread asks for something different.
- Write for Slack: short, friendly, plain sentences. Use *bold* sparingly, no headings.
${mustPropose ? "\nYou have asked enough questions: propose now, with what you know. Note any open question in the problem.\n" : ""}
Repositories of this org:
${repos}

Open work items:
${items}

Answer with JSON only: {"action": "ask", "message": "..."} to ask, or {"action": "propose", "message": "a one-line intro to the proposal", "spec": {...}}.`;
}

export type TranscriptMessage = { user?: string; botId?: string; text?: string; subtype?: string };

/**
 * A Slack thread as the model's conversation: the bot's own messages are its
 * turns; everyone else's are the user's, prefixed with who wrote them and with
 * the bot's mention taken out. Trimmed to the newest that fit, so a long
 * thread can't run the call up.
 */
export function transcript(
  messages: readonly TranscriptMessage[],
  bot: { userId: string; botId?: string | null },
  names: ReadonlyMap<string, string>,
): ChatMessage[] {
  const mention = new RegExp(`<@${bot.userId}(\\|[^>]*)?>`, "g");
  const turns: ChatMessage[] = [];
  for (const m of messages) {
    if (m.subtype && m.subtype !== "thread_broadcast" && m.subtype !== "bot_message") continue;
    const own = m.user === bot.userId || (bot.botId != null && m.botId === bot.botId);
    const text = slackToMarkdown((m.text ?? "").replace(mention, "").trim());
    if (!text) continue;
    if (own) {
      turns.push({ role: "assistant", content: text });
    } else {
      const who = m.user ? (names.get(m.user) ?? m.user) : "someone";
      turns.push({ role: "user", content: `${who}: ${text}` });
    }
  }
  // Newest first until the budget runs out, then back in order.
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    used += turns[i].content.length;
    if (used > MAX_TRANSCRIPT_CHARS && kept.length > 0) break;
    kept.unshift(turns[i]);
  }
  // The model's conversation starts with a user turn.
  while (kept.length > 0 && kept[0].role === "assistant") kept.shift();
  return kept;
}

/** The JSON schema the model answers in (OpenRouter structured outputs). */
export const AGENT_REPLY_SCHEMA = {
  name: "outrunner_intake_reply",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["action", "message", "spec"],
    properties: {
      action: { type: "string", enum: ["ask", "propose"] },
      message: { type: "string" },
      spec: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["title", "repo", "problem", "acceptance_criteria", "out_of_scope", "prompt"],
        properties: {
          title: { type: "string" },
          repo: { type: ["string", "null"] },
          problem: { type: "string" },
          acceptance_criteria: { type: "array", items: { type: "string" } },
          out_of_scope: { type: "array", items: { type: "string" } },
          prompt: { type: "string" },
        },
      },
    },
  },
} as const;

function strings(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, max)
    : [];
}

/**
 * The model's answer, checked. A proposal needs a title, a problem, at least
 * one acceptance criterion and a prompt; a repo not among the org's is
 * dropped (null) rather than trusted. Anything else is null: the caller says
 * it couldn't answer.
 */
export function parseAgentReply(raw: string, repos: readonly string[]): AgentReply | null {
  let data: unknown;
  try {
    data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const message = typeof d.message === "string" ? d.message.trim() : "";
  if (d.action === "ask") return message ? { action: "ask", message } : null;
  if (d.action !== "propose" || !d.spec || typeof d.spec !== "object") return null;
  const s = d.spec as Record<string, unknown>;
  const title = typeof s.title === "string" ? titleFromText(s.title, 120) : "";
  const problem = typeof s.problem === "string" ? s.problem.trim() : "";
  const prompt = typeof s.prompt === "string" ? s.prompt.trim() : "";
  const acceptanceCriteria = strings(s.acceptance_criteria, 12);
  if (!title || !problem || !prompt || acceptanceCriteria.length === 0) return null;
  const repo = typeof s.repo === "string" ? (repos.find((r) => r.toLowerCase() === s.repo?.toString().trim().toLowerCase()) ?? null) : null;
  return {
    action: "propose",
    message: message || "Here's what I'd file:",
    spec: { title, repo, problem, acceptanceCriteria, outOfScope: strings(s.out_of_scope, 8), prompt },
  };
}

/** The work item's body: the spec, in Markdown. */
export function specMarkdown(spec: AgentSpec): string {
  const lines = [spec.problem, "", "**Acceptance criteria**", ...spec.acceptanceCriteria.map((c) => `- [ ] ${c}`)];
  if (spec.outOfScope.length) lines.push("", "**Out of scope**", ...spec.outOfScope.map((c) => `- ${c}`));
  return lines.join("\n");
}

/**
 * The prompt the worker session starts with: the agent's, then what every
 * worker is held to, which code adds so no model can leave it out: the
 * acceptance criteria, and a pull request that names the item and lists them,
 * which is what the validator checks.
 */
export function workerPrompt(spec: AgentSpec, item: { key: string; url: string }): string {
  return [
    spec.prompt,
    "",
    `This is ${item.key} (${item.url}). Acceptance criteria:`,
    ...spec.acceptanceCriteria.map((c) => `- ${c}`),
    "",
    `When the work is done, open a pull request. Its description must start with "Closes ${item.key}", then list the acceptance criteria as a checklist, ticking the ones the change meets and saying how you checked each. Don't tick one you couldn't check.`,
  ].join("\n");
}

type Block = Record<string, unknown>;

/** Slack's markup, escaped where text is shown as is. */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function specSections(spec: AgentSpec): Block[] {
  const blocks: Block[] = [
    { type: "section", text: { type: "mrkdwn", text: cap(`*${esc(spec.title)}*\n${spec.repo ? `\`${spec.repo}\`` : "_No repository yet: pick one when it's triaged._"}`, 2900) } },
    { type: "section", text: { type: "mrkdwn", text: cap(esc(spec.problem), 2900) } },
    {
      type: "section",
      text: { type: "mrkdwn", text: cap(`*Done when*\n${spec.acceptanceCriteria.map((c) => `• ${esc(c)}`).join("\n")}`, 2900) },
    },
  ];
  if (spec.outOfScope.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: cap(`Out of scope: ${spec.outOfScope.map(esc).join(" · ")}`, 2900) }],
    });
  }
  return blocks;
}

/** Action ids of the spec card's buttons. */
export const SPEC_ACTIONS = { file: "spec_file", fileStart: "spec_file_start", refine: "spec_refine" } as const;

/** The spec card: the proposal and what can be done with it. Starting needs
 *  a repository, so without one there's no start button. */
export function specCard(spec: AgentSpec, conversationId: string): Block[] {
  const buttons: Block[] = [
    {
      type: "button",
      action_id: SPEC_ACTIONS.file,
      text: { type: "plain_text", text: "File to triage" },
      value: conversationId,
    },
  ];
  if (spec.repo) {
    buttons.push({
      type: "button",
      action_id: SPEC_ACTIONS.fileStart,
      style: "primary",
      text: { type: "plain_text", text: "File & start session" },
      value: conversationId,
    });
  }
  buttons.push({
    type: "button",
    action_id: SPEC_ACTIONS.refine,
    text: { type: "plain_text", text: "Keep refining" },
    value: conversationId,
  });
  return [...specSections(spec), { type: "actions", elements: buttons }];
}

/** The card once it's filed: the spec, and who filed it where. */
export function filedCard(spec: AgentSpec, filed: { key: string; url: string; by: string; started: boolean }): Block[] {
  return [
    ...specSections(spec),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Filed as <${filed.url}|${filed.key}> by ${esc(filed.by)}${filed.started ? " · starting a session" : ""}`,
        },
      ],
    },
  ];
}

/** A fallback title for the card's notification text. */
export function specSummary(spec: AgentSpec): string {
  return `Proposed: ${spec.title}`;
}
