import type { AgentEvent, ContentBlock } from "@/lib/runtime/agent-protocol";
import { isInterruption, isLocalCommand, localCommandLine, messageText } from "@/lib/runtime/conversation-events";
import { EXIT_PLAN_MODE, planOf } from "@/lib/runtime/pending-plan";
import { parseCommentQuotes } from "@/lib/session/diff-comments";
import { isEcho } from "@/lib/session/optimistic-echo";

type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;

/** A row of the conversation. Each of Claude's steps is a row of its own: a
 *  thought, a tool call (carrying its result, which arrives in a later
 *  message), or its words. */
export type ConversationNode =
  | { kind: "state"; key: string; state: string }
  | { kind: "usage"; key: string; event: Extract<AgentEvent, { t: "usage" }> }
  /** `mode` "plan": sent in plan mode. */
  | { kind: "prompt"; key: string; text: string; mode?: "plan" }
  /** A slash command Claude ran itself ("/model opus"), as typed. */
  | { kind: "command"; key: string; text: string }
  /** The conversation compacted here. */
  | { kind: "compact"; key: string; trigger?: string; preTokens?: number }
  /** A plan the agent proposed: Claude's ExitPlanMode call (`id` its id), or
   *  Codex's last words in a turn sent in plan mode (`id` their uuid). */
  | { kind: "plan"; key: string; id: string; text: string }
  /** The user stopped the turn. */
  | { kind: "interrupted"; key: string }
  | { kind: "prose"; key: string; text: string; at: string }
  | { kind: "thought"; key: string; seconds: number | null }
  | {
      kind: "tool";
      key: string;
      name: string;
      input: unknown;
      /** The result's content, once it has arrived. */
      result: { content: unknown } | null;
    };

/**
 * Flatten the event stream into rows. A tool result is shown with the call it
 * answers, matched by id, not as a row of its own; one that answers no call in
 * the stream is dropped.
 *
 * `plansInProse` is for an agent with no plan step (Codex): the last words of
 * a turn sent in plan mode are its plan, once the turn is over (`working`
 * false, or a later prompt).
 */
export function conversationNodes(
  events: AgentEvent[],
  { plansInProse = false, working = false }: { plansInProse?: boolean; working?: boolean } = {},
): ConversationNode[] {
  const results = new Map<string, unknown>();
  for (const event of events) {
    if (event.t !== "message") continue;
    for (const block of event.content) {
      if (block.type === "tool_result") results.set(block.toolUseId, block.content);
    }
  }

  const nodes: ConversationNode[] = [];
  // When the message before this one was written: a thought runs from there.
  let previousAt: string | null = null;
  // The turn under way, sent in plan mode, and its last words so far (for
  // plansInProse): where they are in `nodes`, and whose they are.
  let planTurn = false;
  let lastWords: { index: number; uuid: string } | null = null;
  const endTurn = () => {
    if (plansInProse && planTurn && lastWords) {
      const words = nodes[lastWords.index];
      if (words.kind === "prose") nodes[lastWords.index] = { kind: "plan", key: words.key, id: lastWords.uuid, text: words.text };
    }
    planTurn = false;
    lastWords = null;
  };
  events.forEach((event, ei) => {
    if (event.t === "state") {
      if (!staleStart(events, ei)) nodes.push({ kind: "state", key: `st-${ei}`, state: event.state });
      return;
    }
    if (event.t === "usage") {
      nodes.push({ kind: "usage", key: `us-${ei}`, event });
      return;
    }
    if (isInterruption(event)) {
      nodes.push({ kind: "interrupted", key: `${event.uuid}-${ei}` });
      previousAt = event.timestamp;
      lastWords = null; // a stopped plan is no plan
      return;
    }
    if (event.compact) {
      nodes.push({ kind: "compact", key: `${event.uuid}-${ei}`, ...event.compact });
      previousAt = event.timestamp;
      return;
    }
    if (isLocalCommand(event)) {
      // What a command printed stays out, and /compact is its compaction's row.
      const line = localCommandLine(messageText(event));
      if (line && !/^\/compact\b/.test(line)) nodes.push({ kind: "command", key: `${event.uuid}-${ei}`, text: line });
      return;
    }
    event.content.forEach((block, bi) => {
      const key = `${event.uuid}-${ei}-${bi}`;
      switch (block.type) {
        case "text":
          if (event.role === "user") {
            endTurn();
            planTurn = event.mode === "plan";
            nodes.push({ kind: "prompt", key, text: block.text, ...(event.mode && { mode: event.mode }) });
          } else {
            lastWords = { index: nodes.length, uuid: event.uuid };
            nodes.push({ kind: "prose", key, text: block.text, at: event.timestamp });
          }
          return;
        case "thinking":
          nodes.push({ kind: "thought", key, seconds: thoughtSeconds(previousAt, event.timestamp) });
          return;
        case "tool_use": {
          const plan = block.name === EXIT_PLAN_MODE ? planOf(block.input) : null;
          nodes.push(plan ? { kind: "plan", key, id: block.id, text: plan } : toolNode(key, block, results));
          return;
        }
        case "tool_result":
          return;
      }
    });
    previousAt = event.timestamp;
  });
  if (!working) endTurn();
  return nodes;
}

/**
 * Whether the state event at `index` is a "starting" that the stream has
 * since outgrown. "starting" only means Claude's log didn't exist yet. The
 * agent now sends "running" when the log appears, but agents older than that
 * sent the state only once, as the stream connected, and boxes keep running
 * them until upgraded, so this stays. Once a message from the log follows it,
 * the session is running, and the row would only misstate it. The echo of a
 * prompt just sent is not from the log: the session may not have taken it yet
 * (a box still booting), so it is still starting.
 */
function staleStart(events: AgentEvent[], index: number): boolean {
  const event = events[index];
  if (event.t !== "state" || event.state !== "starting") return false;
  return events.slice(index + 1).some((later) => later.t === "message" && !isEcho(later.uuid));
}

function toolNode(key: string, block: ToolUse, results: Map<string, unknown>): ConversationNode {
  return {
    kind: "tool",
    key,
    name: block.name,
    input: block.input,
    result: results.has(block.id) ? { content: results.get(block.id) } : null,
  };
}

/**
 * How long a thought took, in whole seconds: from the message before it to
 * the one that holds it (written as the thought ends). Null when either time
 * is missing or unreadable, or the gap is under a second or runs backwards
 * (clock skew), so the row says just "Thought".
 */
export function thoughtSeconds(previousAt: string | null, at: string): number | null {
  if (previousAt === null) return null;
  const ms = Date.parse(at) - Date.parse(previousAt);
  if (!Number.isFinite(ms) || ms < 1000) return null;
  return Math.round(ms / 1000);
}

/** A turn of the conversation, as the turn rail shows it: the prompt that
 *  starts it (`key` is its row's), and the last of Claude's words in it, as
 *  plain text; null while it has said none. */
export type ConversationTurn = { key: string; prompt: string; reply: string | null };

/** The conversation's turns, one per prompt, in order. Rows before the first
 *  prompt (a session's state) belong to none. */
export function conversationTurns(nodes: ConversationNode[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const node of nodes) {
    if (node.kind === "prompt") turns.push({ key: node.key, prompt: promptPreview(node.text), reply: null });
    else if (node.kind === "prose" && turns.length > 0) {
      const reply = plainText(node.text);
      if (reply) turns[turns.length - 1].reply = reply;
    }
  }
  return turns;
}

/** A prompt as the turn rail names it: its words, without the comments on
 *  the diff it carried; one of comments alone says so. */
function promptPreview(text: string): string {
  const { text: words, quotes } = parseCommentQuotes(text);
  if (quotes.length === 0 || words.trim()) return plainText(words);
  return quotes.length === 1 ? "1 comment on the diff" : `${quotes.length} comments on the diff`;
}

/**
 * Markdown read as a line of plain text, for a preview: links by their text,
 * code without its fences and backticks, and no emphasis, heading or list
 * marks; whitespace runs as one space.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*`~]+/g, "")
    // Underscores only as emphasis: user_turn_count and claude_agent.go keep theirs.
    .replace(/(^|\W)_+|_+(?=\W|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Which turn is the one being read: the last whose prompt has reached the
 * reading line (`line`, in the same coordinates as `tops`, each prompt's
 * offset from the conversation's top); the first while none has. -1 with no
 * turns.
 */
export function currentTurn(tops: number[], line: number): number {
  if (tops.length === 0) return -1;
  let current = 0;
  tops.forEach((top, i) => {
    if (top <= line) current = i;
  });
  return current;
}
