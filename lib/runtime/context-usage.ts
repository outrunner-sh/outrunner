/**
 * How full a session's context is, for the composer's ring: what its latest
 * reply read, out of the model's window. Read from the reply's usage
 * (ConversationMessage.usage), which Claude's and Codex's logs both have; the
 * window from the log where it says (Codex's), else by the model, as Claude
 * Code decides it.
 */

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { isErrorReply } from "@/lib/runtime/conversation-events";

/** Claude Code's auto-compact buffer: it compacts this far short of the
 *  window, 1M or 200k alike (its /context, "Autocompact buffer: 33k"). */
export const AUTOCOMPACT_BUFFER = 33_000;

/** The first version of each family whose window is a million tokens without
 *  `[1m]`. Claude Code keeps a table of these (code.claude.com/docs/en/
 *  model-config): its model catalog says 1M for Opus 4.6 and Sonnet 4.6 too,
 *  but it runs them at 200k unless asked. */
const NATIVE_1M: Record<string, [major: number, minor: number]> = {
  opus: [4, 7],
  sonnet: [5, 0],
  haiku: [5, 5],
  fable: [0, 0],
};

/** A Claude model's family and version, read as Claude Code reads an ID: from
 *  its "claude-<family>-<major>[-<minor>]" wherever that is in it, so bare
 *  (claude-opus-5-5), dated (…-20261001), Bedrock's (us.anthropic.claude-
 *  opus-4-7-v1:0) and Vertex's (claude-opus-4-7@20260101) alike. A dotted
 *  minor isn't one: OpenRouter's anthropic/claude-opus-4.7 is Opus 4 to it,
 *  so 200k, and anthropic/claude-haiku-5.5 Haiku 5 (Claude Code 2.1.304's
 *  /context, Nov 12). An alias is the family's newest. */
function claudeModel(model: string): { family: string; major: number; minor: number } | null {
  const id = model.toLowerCase().replace(/\[1m\]$/, "");
  const alias = /^(opus|sonnet|haiku|fable)$/.exec(id);
  if (alias) return { family: alias[1], major: Infinity, minor: 0 };
  const m = /claude-(opus|sonnet|haiku|fable)-(\d)(?!\d)(?:-(\d{1,2})(?!\d))?/.exec(id);
  return m ? { family: m[1], major: Number(m[2]), minor: Number(m[3] ?? 0) } : null;
}

/** Claude's context, which its log never says: a million tokens on a model
 *  that has it natively (Opus 4.7+, Sonnet 5+, Haiku 5.5+, Fable) or is run
 *  with it ("claude-opus-4-6[1m]"), else 200k, as Claude Code assumes for an
 *  ID it doesn't know (a gateway's GLM, Kimi, DeepSeek). The aliases are 1M
 *  where Claude Code runs them itself; on a gateway the log and the composer
 *  name the gateway's model instead. */
export function contextWindowFor(model: string | undefined): number {
  if (!model) return 200_000;
  if (/\[1m\]$/i.test(model)) return 1_000_000;
  const claude = claudeModel(model);
  if (!claude) return 200_000;
  const [major, minor] = NATIVE_1M[claude.family];
  const native = claude.major > major || (claude.major === major && claude.minor >= minor);
  return native ? 1_000_000 : 200_000;
}

export type ContextUsage = {
  used: number;
  window: number;
  /** Where Claude Code compacts on its own: short of the window by its
   *  buffer, or where this session last did. Null for Codex's, whose log says
   *  its window but not that. */
  compactAt: number | null;
};

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
      const before = contextUsage(events.slice(0, i), model);
      const window = before?.window ?? contextWindowFor(model);
      const compactAt =
        before?.compactAt === null ? null : (autoCompactedAt(event) ?? before?.compactAt ?? claudeCompactAt(window));
      return { used: left, window, compactAt };
    }
    // A failed turn's stand-in reply counts no tokens: the call before it says.
    if (event.role !== "assistant" || !event.usage || isErrorReply(event)) continue;
    const u = event.usage;
    // What the call read, as Claude Code counts it: what it wrote is in the
    // next call's input. Or the call's own, where the log says it apart from
    // usage (Codex's, whose usage can carry a late call's too).
    const used = event.contextTokens ?? u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
    if (event.contextWindow) return { used, window: event.contextWindow, compactAt: null };
    const window = contextWindowFor(event.model ?? model);
    return { used, window, compactAt: lastAutoCompaction(events.slice(0, i)) ?? claudeCompactAt(window) };
  }
  return null;
}

function claudeCompactAt(window: number): number {
  return window - AUTOCOMPACT_BUFFER;
}

/** How full the context was when Claude compacted it on its own: where this
 *  session really compacts, whatever its settings. A /compact's is wherever
 *  it was run, so says nothing. */
function autoCompactedAt(event: AgentEvent): number | undefined {
  return event.t === "message" && event.compact?.trigger === "auto" ? event.compact.preTokens || undefined : undefined;
}

function lastAutoCompaction(events: AgentEvent[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const at = autoCompactedAt(events[i]);
    if (at) return at;
  }
  return undefined;
}

/** How near compaction (or the window, where there's none) the context is:
 *  "ok"; "near", as it gets close; "now", just before, when /compact is
 *  worth running first; "over", past the window. */
export type ContextLevel = "ok" | "near" | "now" | "over";

export function contextLevel(usage: ContextUsage): ContextLevel {
  if (usage.used > usage.window) return "over";
  const limit = usage.compactAt ?? usage.window;
  if (usage.used >= limit * 0.95) return "now";
  if (usage.used >= limit * 0.8) return "near";
  return "ok";
}

/** A count of tokens as the ring says it: 812, 45.2k, 1.2M. */
export function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
