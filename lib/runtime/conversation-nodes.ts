import { withoutCarried } from "@/lib/session/chats";
import type { AgentEvent, ContentBlock } from "@/lib/runtime/agent-protocol";
import { isInterruption, isLocalCommand, localCommandLine, messageText, runnerContinuations } from "@/lib/runtime/conversation-events";
import { EXIT_PLAN_MODE, planOf } from "@/lib/runtime/pending-plan";
import { between } from "@/lib/runtime/turn-timing";
import { parseCommentQuotes } from "@/lib/session/diff-comments";
import { isEcho } from "@/lib/session/optimistic-echo";
import { isImageName, promptAttachments } from "@/lib/runtime/attachments";

type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;

/** An image a prompt carries in its log (ConversationNode's `images`). */
export type PromptImage = { mediaType: string; data: string };

const TYPED_COMPACT = /^\/compact(\s|$)/;

/** A row of the conversation. Each of Claude's steps is a row of its own: a
 *  thought, a tool call (carrying its result, which arrives in a later
 *  message), or its words. */
export type ConversationNode =
  | { kind: "harness"; key: string; from: string; to: string }
  | { kind: "state"; key: string; state: string }
  | { kind: "usage"; key: string; event: Extract<AgentEvent, { t: "usage" }> }
  /** `mode` "plan": sent in plan mode. `at` is when it was sent; none on the
   *  echo of one still on its way. `continuation`: Runner news absorbed into
   *  the running turn, so it starts neither a clock nor a turn-rail tick. */
  | {
      kind: "prompt";
      key: string;
      text: string;
      mode?: "plan";
      at?: string;
      continuation?: true;
      /** Images pasted into the agent's own prompt (its terminal), which
       *  its log keeps with the words: base64, by type. */
      images?: PromptImage[];
      /** What a chat's prompt was sent with, out of `text`: a fork's handoff
       *  of the conversation it continues, a side chat's context. */
      carried?: ("handoff" | "side")[];
      /** The message it is, for an edit of it; none on an echo, which isn't
       *  in the log yet. */
      uuid?: string;
    }
  /** Claude's own injected record (a skill's instructions, a reminder): folded
   *  behind a disclosure rather than shown inline. `label` names it in a word. */
  | { kind: "meta"; key: string; label: string; text: string }
  /** A slash command Claude ran itself ("/model opus"), as typed. */
  | { kind: "command"; key: string; text: string }
  /** The conversation compacted here. */
  | { kind: "compact"; key: string; trigger?: string; preTokens?: number; postTokens?: number }
  /** A plan the agent proposed: Claude's ExitPlanMode call (`id` its id), or
   *  Codex's last words in a turn sent in plan mode (`id` their uuid). */
  | { kind: "plan"; key: string; id: string; text: string }
  /** How long the agent worked on the turn above: from its prompt to its
   *  last step, at `at`. */
  | { kind: "worked"; key: string; ms: number; at: string }
  /** The user stopped the turn. */
  | { kind: "interrupted"; key: string }
  | { kind: "prose"; key: string; text: string; at: string }
  | { kind: "thought"; key: string; seconds: number | null }
  | {
      kind: "tool";
      key: string;
      name: string;
      input: unknown;
      /** The result's content, once it has arrived, and whether the tool
       *  failed. */
      result: { content: unknown; isError?: boolean } | null;
    };

/**
 * Flatten the event stream into rows. A tool result is shown with the call it
 * answers, matched by id, not as a row of its own; one that answers no call in
 * the stream is dropped. A turn the agent worked on ends in a "worked" row
 * once it is over: the next prompt has come, or `working` is false.
 *
 * `plansInProse` is for an agent with no plan step (Codex): the last words of
 * a turn sent in plan mode are its plan, once the turn is over (`working`
 * false, or a later prompt).
 */
export function conversationNodes(
  events: AgentEvent[],
  { plansInProse = false, working = false }: { plansInProse?: boolean; working?: boolean } = {},
): ConversationNode[] {
  const results = new Map<string, { content: unknown; isError?: boolean }>();
  for (const event of events) {
    if (event.t !== "message") continue;
    for (const block of event.content) {
      if (block.type === "tool_result") {
        results.set(block.toolUseId, { content: block.content, ...(block.isError && { isError: true }) });
      }
    }
  }

  const nodes: ConversationNode[] = [];
  const continuations = runnerContinuations(events);
  // When the message before this one was written: a thought runs from there.
  let previousAt: string | null = null;
  // The turn under way: when its prompt was sent and its latest step (for
  // its "worked" row); whether it was sent in plan mode, and its last words
  // so far (for plansInProse): where they are in `nodes`, and whose.
  let turn: { from: string; last: string | null; key: string } | null = null;
  let planTurn = false;
  let lastWords: { index: number; uuid: string } | null = null;
  const endTurn = () => {
    if (plansInProse && planTurn && lastWords) {
      const words = nodes[lastWords.index];
      if (words.kind === "prose") nodes[lastWords.index] = { kind: "plan", key: words.key, id: lastWords.uuid, text: words.text };
    }
    planTurn = false;
    lastWords = null;
    const ms = turn?.last ? between(turn.from, turn.last) : null;
    // Under a second is no work to speak of (a command Claude ran itself).
    if (turn?.last && ms !== null && ms >= 1000) nodes.push({ kind: "worked", key: `wk-${turn.key}`, ms, at: turn.last });
    turn = null;
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
    // An edit's cut is applied as it arrives (appendEvent): nothing to show.
    if (event.t === "rewind") return;
    // A prompt starts a turn (the echo of one not yet sent starts none: it
    // has no time of its own); anything after it is a step of it.
    // A record of a slash command Claude ran itself is a step of the turn
    // too (/compact's), not one of its own.
    const continuation = turn !== null && continuations.has(ei);
    const internalRecord = event.role === "user" && event.content.some(
      (block) => block.type === "text" && metaLabel(event.meta === true, block.text) !== null,
    );
    const visiblePrompt = event.role === "user" && event.content.some(
      (block) => block.type === "text" && metaLabel(event.meta === true, block.text) === null,
    );
    const hiddenMeta = event.role === "user" && event.content.some((block) => block.type === "text") && !visiblePrompt;
    if (visiblePrompt && !isInterruption(event) && !isLocalCommand(event) && !continuation) {
      endTurn();
      // A typed /compact starts no turn of its own: it has no prompt row
      // (its compaction's row says it), so a "worked" row under it would
      // stand under no prompt; and folded into the turn before, that turn's
      // would run on to the compaction, however long after it was.
      const compactTyped = event.content.some((b) => b.type === "text" && TYPED_COMPACT.test(b.text));
      if (!isEcho(event.uuid) && !compactTyped) turn = { from: event.timestamp, last: null, key: `${event.uuid}-${ei}` };
    } else if (turn && !hiddenMeta) {
      turn.last = event.timestamp;
    }
    if (isInterruption(event)) {
      nodes.push({ kind: "interrupted", key: `${event.uuid}-${ei}` });
      previousAt = event.timestamp;
      lastWords = null; // a stopped plan is no plan
      return;
    }
    if (event.harness) {
      endTurn();
      lastWords = null;
      nodes.push({ kind: "harness", key: event.uuid, ...event.harness });
      return;
    }
    if (event.compact) {
      nodes.push({ kind: "compact", key: `${event.uuid}-${ei}`, ...event.compact });
      previousAt = event.timestamp;
      return;
    }
    if (isLocalCommand(event) && !internalRecord) {
      // What a command printed stays out, and /compact is its compaction's row.
      const line = localCommandLine(messageText(event));
      if (line && !/^\/compact\b/.test(line)) nodes.push({ kind: "command", key: `${event.uuid}-${ei}`, text: line });
      return;
    }
    // Images pasted into the prompt go with its words, on their row.
    let images: PromptImage[] | null =
      event.role === "user"
        ? event.content.flatMap((block) =>
            block.type === "image" && block.source?.data
              ? [{ mediaType: block.source.media_type ?? "image/png", data: block.source.data }]
              : [],
          )
        : null;
    if (images?.length === 0) images = null;
    event.content.forEach((block, bi) => {
      const key = `${event.uuid}-${ei}-${bi}`;
      switch (block.type) {
        case "text":
          if (event.role === "user") {
            // The turn it starts was begun above (endTurn, then `turn`).
            // Claude Code 2.1.304 records a typed /compact first as a prompt of
            // its own: the compaction's row says it.
            if (TYPED_COMPACT.test(block.text)) return;
            const label = metaLabel(event.meta === true, block.text);
            if (label !== null) {
              nodes.push({ kind: "meta", key, label, text: block.text });
              return;
            }
            if (!continuation) planTurn = event.mode === "plan";
            const { text, carried } = withoutCarried(block.text);
            nodes.push({
              kind: "prompt",
              key,
              text,
              ...(carried.length > 0 && { carried }),
              ...(!isEcho(event.uuid) && { uuid: event.uuid }),
              ...(event.mode && { mode: event.mode }),
              ...(!isEcho(event.uuid) && { at: event.timestamp }),
              ...(continuation && { continuation: true }),
              ...(images && { images }),
            });
            images = null;
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
        case "image":
          return;
      }
    });
    previousAt = event.timestamp;
  });
  if (!working) endTurn();
  return nodes;
}

/**
 * A short label for an internal user record, or null when it's the user's own
 * prompt and belongs inline. A record is internal when Claude marked it so
 * (`meta`: a skill's instructions, a reminder it folds away), or when its text
 * is one of the wrappers that are always injected whole and never carry the
 * user's words. `<system_instruction>` is deliberately not among them: an
 * attached-file prompt leads with that wrapper and the user's words follow, so
 * hiding it would hide the prompt.
 */
/** /context's report (isContextReport): shown open, as Markdown. */
export const CONTEXT_USAGE = "Context usage";

export function metaLabel(meta: boolean, text: string): string | null {
  const t = text.trimStart();
  if (t.startsWith("Base directory for this skill")) return "Skill";
  if (t.startsWith("<command-name>") || t.startsWith("<command-message>")) return "Command";
  if (t.startsWith("<local-command-stdout>") || t.startsWith("<local-command-stderr>")) return "Command output";
  if (t.startsWith("<task-notification>")) return "Background task";
  if (meta && t.startsWith("## Context Usage")) return CONTEXT_USAGE;
  if (t.startsWith("<system-reminder>")) return "System reminder";
  return meta ? "Internal" : null;
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

function toolNode(
  key: string,
  block: ToolUse,
  results: Map<string, { content: unknown; isError?: boolean }>,
): ConversationNode {
  return {
    kind: "tool",
    key,
    name: block.name,
    input: block.input,
    result: results.get(block.id) ?? null,
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

/** The running clock starts at the turn's prompt, not Runner news folded
 *  into it. An optimistic prompt still on its way has no start time. */
export function conversationTurnSince(nodes: ConversationNode[]): string | undefined {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.kind === "prompt" && !node.continuation) return node.at;
  }
  return undefined;
}

/** The conversation's turns, one per prompt, in order. Rows before the first
 *  prompt (a session's state) belong to none. */
export function conversationTurns(nodes: ConversationNode[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const node of nodes) {
    if (node.kind === "prompt" && !node.continuation) turns.push({ key: node.key, prompt: promptPreview(node.text), reply: null });
    else if (node.kind === "prose" && turns.length > 0) {
      const reply = plainText(node.text);
      if (reply) turns[turns.length - 1].reply = reply;
    }
  }
  return turns;
}

/** A prompt as the turn rail names it: its words, without the files it
 *  carried or the comments on the diff; one of files or comments alone
 *  says so. */
export function promptPreview(text: string): string {
  const { text: typed, files } = promptAttachments(text);
  const { text: words, quotes } = parseCommentQuotes(typed);
  if (words.trim()) return plainText(words);
  if (quotes.length > 0) return quotes.length === 1 ? "1 comment on the diff" : `${quotes.length} comments on the diff`;
  if (files.length > 0) return filesPreview(files);
  return plainText(words);
}

/** Files alone, in a word or two: "Image", "3 images", "2 files". */
function filesPreview(files: string[]): string {
  const images = files.every((file) => isImageName(file));
  if (files.length === 1) return images ? "Image" : "File";
  return `${files.length} ${images ? "images" : "files"}`;
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
