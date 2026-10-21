import type { AgentEvent, ContentBlock } from "@/lib/runtime/agent-protocol";

type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;

/** A row of the conversation. Each of Claude's steps is a row of its own: a
 *  thought, a tool call (carrying its result, which arrives in a later
 *  message), or its words. */
export type ConversationNode =
  | { kind: "state"; key: string; state: string }
  | { kind: "usage"; key: string; event: Extract<AgentEvent, { t: "usage" }> }
  | { kind: "prompt"; key: string; text: string }
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
 */
export function conversationNodes(events: AgentEvent[]): ConversationNode[] {
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
  events.forEach((event, ei) => {
    if (event.t === "state") {
      nodes.push({ kind: "state", key: `st-${ei}`, state: event.state });
      return;
    }
    if (event.t === "usage") {
      nodes.push({ kind: "usage", key: `us-${ei}`, event });
      return;
    }
    event.content.forEach((block, bi) => {
      const key = `${event.uuid}-${ei}-${bi}`;
      switch (block.type) {
        case "text":
          nodes.push(
            event.role === "user"
              ? { kind: "prompt", key, text: block.text }
              : { kind: "prose", key, text: block.text, at: event.timestamp },
          );
          return;
        case "thinking":
          nodes.push({ kind: "thought", key, seconds: thoughtSeconds(previousAt, event.timestamp) });
          return;
        case "tool_use":
          nodes.push(toolNode(key, block, results));
          return;
        case "tool_result":
          return;
      }
    });
    previousAt = event.timestamp;
  });
  return nodes;
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
