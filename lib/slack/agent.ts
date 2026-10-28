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

export type AgentReply =
  | { action: "ask"; message: string }
  | { action: "propose"; message: string; spec: AgentSpec }
  /** A question answered from the lookups. */
  | { action: "answer"; message: string }
  /** A question about the code itself, for the thread's research session. */
  | { action: "research"; message: string; repo: string; question: string };

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
  return `You are Outrunner, an engineering teammate in a Slack thread. People talk to you here for two things, and you tell which from what they say:

1. Questions. Answer them.
   - About what the team has done or is doing (what shipped, what's open, where an item stands): use the lookup tools (recent_work, find_items, item_status), then reply with action "answer". Give specifics: titles, keys, links, who and when. Never guess what you could look up, and say when a lookup couldn't reach something.
   - About the code itself (how something works, why it behaves a way, where something is, what a change would touch): reply with action "research", naming one repository below and the question as the research session should get it, standalone, with everything from the thread it needs. The research session reads the repository and answers in the thread itself; your message just says you're looking into it.
2. Work to be done (build, fix, change something). Do intake: understand it, ask what you must, then write it up as a precise work item that a coding agent can carry out without asking anything else.
   - Ask only what changes the work: which repository, how to reproduce, expected vs actual behaviour, constraints, and what "done" means. At most 3 short, specific questions at a time, numbered, never what the thread already answers. Reply with action "ask".
   - When you know enough, reply with action "propose". A proposal has: a short imperative title; the repository (exactly one of the names below, or null if it isn't clear); the problem in a few sentences; acceptance criteria as checkable statements (each something a reviewer can verify: a test that passes, a behaviour seen in the app, a command's output); what is out of scope; and the session prompt.
   - The session prompt is for an autonomous coding agent in the repository: the goal, the context from the thread (quote specifics: error messages, URLs, steps), the acceptance criteria, and constraints. Standalone. No instructions about pull requests; they're added for you.
   - If an open item below already covers the request, say so and give its key; still propose if the thread asks for something different.

3. Settings for this channel ("watch this channel", "post a daily digest here at 9am IST", "stop the digest"): call channel_settings, then reply with action "answer" saying what's now set. If they don't give a time zone for an hour, ask which.

Always finish by calling the reply tool exactly once. Read the whole thread: several people may be talking, and messages are prefixed with who wrote them. Never invent facts about the codebase or the team's work. Write for Slack: short, friendly, plain sentences, *bold* sparingly, no headings; links as <url|text>.
${mustPropose ? "\nYou have asked enough questions about this work: propose now, with what you know. Note any open question in the problem.\n" : ""}
Repositories this person can see:
${repos}

Open work items:
${items}`;
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

const REPLY_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["action", "message", "spec", "research"],
  properties: {
    action: { type: "string", enum: ["ask", "propose", "answer", "research"] },
    message: { type: "string", description: "What to post in the thread, in Slack's markup." },
    spec: {
      type: ["object", "null"],
      description: "The proposal, for action propose; otherwise null.",
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
    research: {
      type: ["object", "null"],
      description: "For action research: the repository and the standalone question; otherwise null.",
      additionalProperties: false,
      required: ["repo", "question"],
      properties: { repo: { type: "string" }, question: { type: "string" } },
    },
  },
} as const;

/** The tools the agent has (OpenRouter function calling). The lookups are
 *  read-only; `reply` ends the turn with what to post. */
export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "recent_work",
      description: "Pull requests merged recently in the org's repositories this person can read: title, author, when, link.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["days", "repo"],
        properties: {
          days: { type: "integer", description: "How many days back, 1 to 30." },
          repo: { type: ["string", "null"], description: "One repository (owner/name), or null for all." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_items",
      description: "Triage work items this person can see, newest first, by words in the title and by status.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query", "status"],
        properties: {
          query: { type: ["string", "null"] },
          status: { type: ["string", "null"], enum: ["triage", "todo", "in_progress", "done", "declined", "duplicate", null] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "item_status",
      description: "Where one work item stands: status, its spec, its session, and the session's pull request.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["key"],
        properties: { key: { type: "string", description: "Like OR-42." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "channel_settings",
      description:
        "Change what you do in this channel, when asked to: watch it (offer to file messages that look like bug reports or requests, without being mentioned), and post a daily or weekly digest (what shipped, what's in progress or stuck, what waits in triage) at an hour, local time. Leave a setting null to keep it. Answers the channel's settings after the change.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["watch", "digest", "hour", "timezone"],
        properties: {
          watch: { type: ["boolean", "null"] },
          digest: { type: ["string", "null"], enum: ["daily", "weekly", "off", null] },
          hour: { type: ["integer", "null"], description: "0 to 23, local time." },
          timezone: { type: ["string", "null"], description: "An IANA time zone, like Asia/Kolkata or America/New_York." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reply",
      description: "End the turn: what to post in the thread, and what kind of reply it is.",
      parameters: REPLY_PARAMETERS,
    },
  },
] as const;

/** The tool that ends a turn. */
export const REPLY_TOOL = "reply";

function strings(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, max)
    : [];
}

/**
 * The model's answer (the reply tool's arguments), checked. A proposal needs
 * a title, a problem, at least one acceptance criterion and a prompt; a repo
 * not among the asker's is dropped (null) rather than trusted, and research
 * in one becomes a question about which. Anything else is null: the caller
 * says it couldn't answer.
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
  if (d.action === "answer") return message ? { action: "answer", message } : null;
  if (d.action === "research") {
    const r = (d.research && typeof d.research === "object" ? d.research : {}) as Record<string, unknown>;
    const question = typeof r.question === "string" ? r.question.trim() : "";
    const repo = typeof r.repo === "string" ? repos.find((name) => name.toLowerCase() === String(r.repo).trim().toLowerCase()) : undefined;
    // Research needs a repository the asker can read; without one, it's a
    // question the agent must ask.
    if (!question) return null;
    if (!repo) return { action: "ask", message: message || "Which repository should I look in?" };
    return { action: "research", message: message || "Looking into it in the repository; I'll post here.", repo, question };
  }
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
