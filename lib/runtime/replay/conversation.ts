/**
 * Replay-side conversation parser: raw Claude session JSONL → AgentEvent[].
 *
 * The live Timeline is fed by the agent, which derives events from the JSONL
 * on-box (runtime-agent/internal/conversation). Replay has NO agent and NO box
 * (M4 invariant #2: Replay is browser + storage only), so the same conversion
 * has to run off-box at read time. This is the faithful TS port of the Go
 * `decode`; the two are pinned together by a shared golden fixture
 * (`conversation.fixtures.json`, asserted from both languages) so they cannot
 * silently drift.
 *
 * Like the Go side it is DEFENSIVE: the JSONL is Claude's internal, undocumented
 * log, so it whitelists the record types it renders (user/assistant messages)
 * and tolerates everything else (app-internal types, unparseable lines).
 */
import type { AgentEvent, ContentBlock } from "@/lib/runtime/agent-protocol";

/** Block types the timeline renders; anything else is dropped (matches the live
 *  AgentEvent schema in agent-protocol.ts). */
const KNOWN_BLOCK_TYPES = new Set(["text", "thinking", "tool_use", "tool_result"]);
/** String content-block fields the Go struct marshals with `omitempty`. */
const STRING_KEYS = ["text", "id", "name", "toolUseId"] as const;
/** Raw-JSON content-block fields (json.RawMessage on the Go side). */
const RAW_KEYS = ["input", "content"] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Project a raw content block onto the protocol keys, reproducing the Go struct's
 * marshaling exactly so replay is byte-equivalent to the live decoder:
 *  - string fields (text/id/name/toolUseId) are `omitempty` — dropped when empty;
 *  - `input`/`content` are json.RawMessage — kept whenever the key is PRESENT
 *    (including an explicit `null` or empty string), dropped only when absent.
 */
function cleanBlock(raw: Record<string, unknown>): ContentBlock {
  const out: Record<string, unknown> = {};
  if (typeof raw.type === "string") out.type = raw.type;
  for (const key of STRING_KEYS) {
    if (typeof raw[key] === "string" && raw[key] !== "") out[key] = raw[key];
  }
  // Claude names a tool result's call `tool_use_id`; the logs Runtime writes
  // itself (a Codex translation) say `toolUseId`. Mirrors the Go rawBlock.
  if (!("toolUseId" in out) && typeof raw.tool_use_id === "string" && raw.tool_use_id !== "") {
    out.toolUseId = raw.tool_use_id;
  }
  for (const key of RAW_KEYS) {
    if (key in raw) out[key] = raw[key];
  }
  return out as ContentBlock;
}

/**
 * Parse the whole conversation JSONL into ordered message events. Lines are kept
 * in file order (the Timeline's source of truth); non-message records and
 * malformed lines are skipped. Every field is runtime-checked as `unknown` — a
 * single malformed record must never throw and fail the whole Replay.
 */
export function parseConversation(jsonl: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of jsonl.split("\n")) {
    const event = decodeLine(line);
    if (event) events.push(event);
  }
  return events;
}

function decodeLine(line: string): AgentEvent | null {
  if (line.trim() === "") return null;
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return null; // tolerate unparseable lines
  }
  if (!isObject(rec)) return null;
  if (rec.type === "attachment") return decodeQueuedPrompt(rec);
  if (rec.type !== "user" && rec.type !== "assistant") return null; // whitelist
  const message = rec.message;
  if (!isObject(message)) return null;

  const content = contentOf(message.content);
  if (!content) return null;

  // Mirror the Go `omitempty`: include `model` only when present (assistant
  // turns), so replay stays byte-equivalent to the live decoder and the shared
  // fixture (user turns carry no model).
  const model = typeof message.model === "string" && message.model !== "" ? message.model : undefined;

  return {
    t: "message",
    uuid: typeof rec.uuid === "string" ? rec.uuid : "",
    parentUuid: typeof rec.parentUuid === "string" ? rec.parentUuid : null,
    // Pass the role through as the agent does — never silently relabel an
    // unexpected role as "assistant".
    role: (typeof message.role === "string" ? message.role : "") as "user" | "assistant",
    ...(model ? { model } : {}),
    timestamp: typeof rec.timestamp === "string" ? rec.timestamp : "",
    content,
  };
}

/**
 * A prompt Claude took in mid-turn, as the user message it stands for. Claude
 * records such a prompt only as a queued_command attachment, never as a user
 * message; a queued background-task notice (another commandMode) is Claude's,
 * not the user's, and stays out. Mirrors the Go decodeQueuedPrompt.
 */
function decodeQueuedPrompt(rec: Record<string, unknown>): AgentEvent | null {
  const attachment = rec.attachment;
  if (!isObject(attachment) || attachment.type !== "queued_command") return null;
  const mode = attachment.commandMode;
  // As Go reads it: a mode absent, null or empty is a prompt's.
  if (mode !== undefined && mode !== null && mode !== "" && mode !== "prompt") return null;
  const content = contentOf(attachment.prompt);
  if (!content) return null;
  return {
    t: "message",
    uuid: typeof rec.uuid === "string" ? rec.uuid : "",
    parentUuid: typeof rec.parentUuid === "string" ? rec.parentUuid : null,
    role: "user",
    timestamp: typeof rec.timestamp === "string" ? rec.timestamp : "",
    content,
  };
}

/**
 * A message's content as timeline blocks, or null when there is nothing to
 * render. It is polymorphic: a block array for assistant turns and tool-result
 * user turns, but a plain string for a typed user prompt ("hi"). Mirrors the Go
 * parser (parseContent): wrap a non-empty string in a single text block; keep
 * the array path; drop anything else.
 */
function contentOf(rawContent: unknown): ContentBlock[] | null {
  if (Array.isArray(rawContent) && rawContent.every(isObject)) {
    // Drop block types the timeline can't model (redacted_thinking, image, a
    // newer Claude type) so replay matches the live schema, which does the same —
    // otherwise an archived turn can leave an unrenderable block stuck.
    return rawContent.map(cleanBlock).filter((b) => KNOWN_BLOCK_TYPES.has(b.type));
  }
  if (typeof rawContent === "string") {
    const text = rawContent.trim();
    return text === "" ? null : [{ type: "text", text }]; // empty prompt: nothing to render
  }
  return null;
}
