/**
 * Pure presentation helpers for the Conversation Timeline. Kept free of JSX so
 * the logic is unit-testable under the plain `node --test` runner and reused by
 * `components/conversation-timeline.tsx` without duplication.
 *
 * None of this derives meaning from PTY output — it only reshapes the already
 * structured AgentEvent payloads (see agent-protocol.ts) for display.
 */

import { ASK_TOOL } from "@/lib/runtime/pending-question";

/** Read a string field off an unknown tool-input object without throwing. */
function field(input: unknown, key: string): string | null {
  if (input && typeof input === "object" && key in input) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/** A string field as written, blank or not; "" when absent. For text whose
 *  every line counts (an edit's old and new text), unlike `field`. */
function text(input: unknown, key: string): string {
  if (input && typeof input === "object" && key in input) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * A concise, human-readable summary of a tool call — the single most relevant
 * argument for the common Claude Code tools (the command, the file, the query).
 * Returns null when we don't have a good one-liner, so the caller can fall back
 * to the raw input.
 */
export function describeToolUse(name: string, input: unknown): string | null {
  switch (name) {
    case "Bash":
      return field(input, "command");
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return field(input, "file_path") ?? field(input, "notebook_path");
    case "Glob":
      return field(input, "pattern");
    case "Grep": {
      const pattern = field(input, "pattern");
      const path = field(input, "path");
      if (!pattern) return null;
      return path ? `${pattern}  in ${path}` : pattern;
    }
    case "LS":
      return field(input, "path");
    case "WebFetch":
      return field(input, "url");
    case "WebSearch":
      return field(input, "query");
    case "Task":
    case "Agent":
      return field(input, "description");
    case "TodoWrite": {
      if (
        input &&
        typeof input === "object" &&
        Array.isArray((input as Record<string, unknown>).todos)
      ) {
        const count = ((input as Record<string, unknown>).todos as unknown[])
          .length;
        return `${count} ${count === 1 ? "item" : "items"}`;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Normalize an unknown tool_result `content` payload to a plain string. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  // Claude tool results are often an array of `{ type: "text", text }` blocks.
  if (Array.isArray(content)) {
    const parts = content.map((block) => {
      if (block && typeof block === "object" && "text" in block) {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
      return JSON.stringify(block, null, 2);
    });
    return parts.join("\n");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content, null, 2);
}

export interface ResultSummary {
  /** The full normalized text, as the row shows it. */
  text: string;
  /** Total line count, as an at-a-glance size cue; 0 when there is no output
   *  at all, which the row says in words. */
  lineCount: number;
}

/** A tool result as its row shows it: the text, and how many lines of it. */
export function summarizeToolResult(content: unknown): ResultSummary {
  const text = toolResultText(content);
  const trimmed = text.trim();
  return { text, lineCount: trimmed === "" ? 0 : trimmed.split("\n").length };
}

/** Format a token count with thousands separators; "—" for missing values. */
export function formatTokens(value: number | undefined | null): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US");
}

/** What kind of step a tool call is, for its row's icon. */
export type ToolKind =
  | "command"
  | "create"
  | "edit"
  | "read"
  | "search"
  | "web"
  | "agent"
  | "todo"
  | "question"
  | "other";

export interface ToolRowSummary {
  kind: ToolKind;
  /** The row's words: a command's description, a file's name, a query. */
  label: string;
  /** The label is code (a raw command, a pattern), set in mono. */
  mono: boolean;
  /** The full path or command behind a shortened label, for its tooltip. */
  title: string | null;
  /** Lines added and removed, for a call that changes a file. */
  stats: LineStats | null;
}

export interface LineStats {
  added: number;
  removed: number;
}

/**
 * One tool call as a row of the conversation: an edit by its file's name and
 * the lines it changed, a command by the description Claude gave it (else
 * the command itself), a search by its pattern.
 */
export function toolRow(name: string, input: unknown): ToolRowSummary {
  const path = field(input, "file_path") ?? field(input, "notebook_path");
  const file = (kind: ToolKind, stats: LineStats | null = null): ToolRowSummary => ({
    kind,
    label: path ? baseName(path) : name,
    mono: false,
    title: path,
    stats,
  });
  switch (name) {
    case "Bash": {
      const command = field(input, "command");
      const description = field(input, "description");
      if (description) return { kind: "command", label: description, mono: false, title: command, stats: null };
      return { kind: "command", label: command ?? name, mono: command !== null, title: null, stats: null };
    }
    case "Write":
      return file("create", { added: lineCount(text(input, "content")), removed: 0 });
    case "Edit":
      return file("edit", lineDelta(text(input, "old_string"), text(input, "new_string")));
    case "MultiEdit":
      return file("edit", multiEditStats(input));
    case "NotebookEdit":
      return file("edit");
    case "Read":
      return file("read");
    case ASK_TOOL:
      return { kind: "question", label: askedLabel(input), mono: false, title: null, stats: null };
  }
  const summary = describeToolUse(name, input);
  const kind: ToolKind =
    name === "Grep" || name === "Glob" || name === "LS"
      ? "search"
      : name === "WebFetch" || name === "WebSearch"
        ? "web"
        : name === "Task" || name === "Agent"
          ? "agent"
          : name === "TodoWrite"
            ? "todo"
            : "other";
  if (kind === "agent" && summary) return { kind, label: summary, mono: false, title: null, stats: null };
  return {
    kind,
    label: summary ? `${name} ${summary}` : name,
    mono: kind === "search" && summary !== null,
    title: null,
    stats: null,
  };
}

/** An ask_user call by what it asked: its question, or how many. */
function askedLabel(input: unknown): string {
  const questions =
    input && typeof input === "object" ? (input as Record<string, unknown>).questions : undefined;
  if (!Array.isArray(questions) || questions.length === 0) return "Asked you";
  if (questions.length > 1) return `Asked you ${questions.length} questions`;
  return field(questions[0], "question") ?? "Asked you";
}

/** A path's last segment (either separator), or the path when it has none. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Lines in a file's text: none when empty, a final newline not starting another. */
function lineCount(content: string): number {
  return content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
}

/** Lines an edit adds and removes: the lines either side of the change that
 *  the old and new text share are not counted, as a diff would not. */
export function lineDelta(oldText: string, newText: string): LineStats {
  const before = oldText === "" ? [] : oldText.split("\n");
  const after = newText === "" ? [] : newText.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  return { added: after.length - start - end, removed: before.length - start - end };
}

/** A MultiEdit's lines, summed over its edits; none when it has no readable edits. */
function multiEditStats(input: unknown): LineStats | null {
  const edits = input && typeof input === "object" ? (input as Record<string, unknown>).edits : undefined;
  if (!Array.isArray(edits)) return null;
  return edits.reduce<LineStats>(
    (total, edit) => {
      const { added, removed } = lineDelta(text(edit, "old_string"), text(edit, "new_string"));
      return { added: total.added + added, removed: total.removed + removed };
    },
    { added: 0, removed: 0 },
  );
}

/** How long Claude has been working, for the working indicator: tenths of a
 *  second under a minute ("12.3s"), then whole minutes and seconds ("3m 57s",
 *  "1h 4m 5s"), as a tenth no longer tells anything. */
export function workingElapsed(ms: number): string {
  if (ms < 60_000) return `${(Math.floor(Math.max(0, ms) / 100) / 10).toFixed(1)}s`;
  const total = Math.floor(ms / 1000);
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

/** A thought's row: "Thought for 9s", "Thought for 1m 5s", or just "Thought". */
export function thoughtLabel(seconds: number | null): string {
  if (seconds === null) return "Thought";
  if (seconds < 60) return `Thought for ${seconds}s`;
  const rest = seconds % 60;
  return `Thought for ${Math.floor(seconds / 60)}m${rest ? ` ${rest}s` : ""}`;
}
