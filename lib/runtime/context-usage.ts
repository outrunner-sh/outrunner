/**
 * How full a session's context is, for the composer's ring: what its latest
 * reply read and wrote, out of the model's window. Read from the reply's
 * usage (ConversationMessage.usage), which Claude's and Codex's logs both
 * have; the window from the log where it says (Codex's), else by the model.
 */

import type { AgentEvent } from "@/lib/runtime/agent-protocol";

/** Claude's context, which its log never says: a million tokens on a model
 *  run with it ("claude-opus-4-6[1m]"), else 200k. */
export function contextWindowFor(model: string | undefined): number {
  return model && /\[1m\]$/i.test(model) ? 1_000_000 : 200_000;
}

export type ContextUsage = { used: number; window: number };

/** The context the newest reply left, or null until a reply has said (none
 *  yet, or a reply from an agent before usage). Compacted since, what the
 *  summary left, where the log says; else nothing until the next reply. */
export function contextUsage(events: AgentEvent[], model?: string): ContextUsage | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.t !== "message") continue;
    if (event.compact) {
      const left = event.compact.postTokens;
      if (!left) return null;
      // Out of the window the replies before it ran in.
      return { used: left, window: contextUsage(events.slice(0, i), model)?.window ?? contextWindowFor(model) };
    }
    if (event.role !== "assistant" || !event.usage) continue;
    const u = event.usage;
    // The call's own, where the log says it apart from usage (Codex's, whose
    // usage can carry a late call's too); else usage is the call's alone.
    const used =
      event.contextTokens ?? u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens + u.output_tokens;
    return { used, window: event.contextWindow ?? contextWindowFor(event.model ?? model) };
  }
  return null;
}

/** A count of tokens as the ring says it: 812, 45.2k, 1.2M. */
export function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
