import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeToolUse,
  formatTokens,
  lineDelta,
  summarizeToolResult,
  thoughtLabel,
  toolResultText,
  toolRow,
} from "@/lib/runtime/conversation-format";

test("describeToolUse pulls the primary argument for common tools", () => {
  assert.equal(describeToolUse("Bash", { command: "ls -la" }), "ls -la");
  assert.equal(
    describeToolUse("Read", { file_path: "/repo/index.ts" }),
    "/repo/index.ts",
  );
  assert.equal(
    describeToolUse("NotebookEdit", { notebook_path: "/repo/a.ipynb" }),
    "/repo/a.ipynb",
  );
  assert.equal(describeToolUse("Glob", { pattern: "**/*.ts" }), "**/*.ts");
  assert.equal(describeToolUse("WebSearch", { query: "zod v4" }), "zod v4");
});

test("describeToolUse formats Grep with an optional path", () => {
  assert.equal(describeToolUse("Grep", { pattern: "TODO" }), "TODO");
  assert.equal(
    describeToolUse("Grep", { pattern: "TODO", path: "src" }),
    "TODO  in src",
  );
});

test("describeToolUse counts TodoWrite items with correct pluralization", () => {
  assert.equal(describeToolUse("TodoWrite", { todos: [{}] }), "1 item");
  assert.equal(describeToolUse("TodoWrite", { todos: [{}, {}] }), "2 items");
});

test("describeToolUse returns null when there is no good one-liner", () => {
  assert.equal(describeToolUse("UnknownTool", { foo: "bar" }), null);
  assert.equal(describeToolUse("Bash", {}), null);
  assert.equal(describeToolUse("Bash", { command: "   " }), null);
  assert.equal(describeToolUse("Read", null), null);
});

test("toolResultText normalizes strings, block arrays, and objects", () => {
  assert.equal(toolResultText("plain"), "plain");
  assert.equal(
    toolResultText([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
    "a\nb",
  );
  assert.equal(toolResultText(null), "");
  assert.equal(toolResultText(undefined), "");
  assert.equal(toolResultText({ code: 1 }), '{\n  "code": 1\n}');
});

test("summarizeToolResult previews the first line and flags truncation", () => {
  const single = summarizeToolResult("just one line");
  assert.equal(single.preview, "just one line");
  assert.equal(single.truncated, false);
  assert.equal(single.lineCount, 1);

  const multi = summarizeToolResult("line 1\nline 2\nline 3");
  assert.equal(multi.preview, "line 1");
  assert.equal(multi.truncated, true);
  assert.equal(multi.lineCount, 3);
});

test("summarizeToolResult truncates an overlong first line", () => {
  const long = "x".repeat(200);
  const result = summarizeToolResult(long);
  assert.ok(result.preview.endsWith("…"));
  assert.ok(result.preview.length < long.length);
  assert.equal(result.truncated, true);
});

test("summarizeToolResult labels empty output", () => {
  const empty = summarizeToolResult("   ");
  assert.equal(empty.preview, "(empty result)");
  assert.equal(empty.lineCount, 0);
});

test("formatTokens adds separators and handles missing values", () => {
  assert.equal(formatTokens(1234567), "1,234,567");
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(undefined), "—");
  assert.equal(formatTokens(null), "—");
  assert.equal(formatTokens(Number.NaN), "—");
});

test("a command reads as Claude's description of it, else as the command in mono", () => {
  const described = toolRow("Bash", { command: "pnpm test", description: "Run the tests" });
  assert.deepEqual(
    [described.kind, described.label, described.mono, described.title],
    ["command", "Run the tests", false, "pnpm test"],
  );
  const bare = toolRow("Bash", { command: "pnpm test" });
  assert.deepEqual([bare.label, bare.mono], ["pnpm test", true]);
  // No command at all: the tool's name, not mono.
  assert.deepEqual([toolRow("Bash", {}).label, toolRow("Bash", {}).mono], ["Bash", false]);
});

test("a file step reads as the file's name, its full path in the tooltip", () => {
  const read = toolRow("Read", { file_path: "/repo/components/a.tsx" });
  assert.deepEqual([read.kind, read.label, read.title, read.stats], ["read", "a.tsx", "/repo/components/a.tsx", null]);
  assert.equal(toolRow("Read", { file_path: "C:\\repo\\b.ts" }).label, "b.ts");
  assert.equal(toolRow("Edit", {}).label, "Edit");
});

test("a new file counts its lines as added, a final newline not starting another", () => {
  assert.deepEqual(toolRow("Write", { file_path: "/a.ts", content: "one\ntwo\n" }).stats, { added: 2, removed: 0 });
  assert.deepEqual(toolRow("Write", { file_path: "/a.ts", content: "" }).stats, { added: 0, removed: 0 });
  assert.equal(toolRow("Write", { file_path: "/a.ts" }).kind, "create");
});

test("an edit counts only the lines that changed, not those around them it repeats", () => {
  assert.deepEqual(lineDelta("a\nb\nc", "a\nB\nc"), { added: 1, removed: 1 });
  assert.deepEqual(lineDelta("a\nc", "a\nb\nc"), { added: 1, removed: 0 });
  assert.deepEqual(lineDelta("a\nb\nc", "a\nc"), { added: 0, removed: 1 });
  assert.deepEqual(lineDelta("", "x\ny"), { added: 2, removed: 0 });
  assert.deepEqual(lineDelta("same", "same"), { added: 0, removed: 0 });
  // A repeated line on both sides is counted once, not matched twice.
  assert.deepEqual(lineDelta("x", "x\nx"), { added: 1, removed: 0 });
  // Whitespace-only text is still text.
  assert.deepEqual(toolRow("Edit", { file_path: "/a", old_string: "  ", new_string: "x" }).stats, { added: 1, removed: 1 });
});

test("a multi-edit sums its edits, and has no count without readable edits", () => {
  const input = {
    file_path: "/a.ts",
    edits: [
      { old_string: "a", new_string: "b" },
      { old_string: "", new_string: "c\nd" },
    ],
  };
  assert.deepEqual(toolRow("MultiEdit", input).stats, { added: 3, removed: 1 });
  assert.equal(toolRow("MultiEdit", { file_path: "/a.ts" }).stats, null);
});

test("other tools read as their name and primary argument", () => {
  const grep = toolRow("Grep", { pattern: "TODO" });
  assert.deepEqual([grep.kind, grep.label, grep.mono], ["search", "Grep TODO", true]);
  assert.deepEqual([toolRow("WebSearch", { query: "zod" }).kind, toolRow("WebSearch", { query: "zod" }).label], ["web", "WebSearch zod"]);
  assert.equal(toolRow("Agent", { description: "Find the bug" }).label, "Find the bug");
  assert.deepEqual([toolRow("mcp__x__y", {}).kind, toolRow("mcp__x__y", {}).label], ["other", "mcp__x__y"]);
});

test("a thought says how long it took, when known", () => {
  assert.equal(thoughtLabel(null), "Thought");
  assert.equal(thoughtLabel(9), "Thought for 9s");
  assert.equal(thoughtLabel(60), "Thought for 1m");
  assert.equal(thoughtLabel(125), "Thought for 2m 5s");
});
