import assert from "node:assert/strict";
import { test } from "node:test";

import { groupWorkItems, tabCounts } from "@/lib/triage/groups";
import {
  itemKey,
  parseNewWorkItem,
  parseNoteBody,
  parseWorkItemPatch,
  safeUrl,
  titleFromText,
  type WorkItem,
  type WorkItemNote,
  workItemPrompt,
} from "@/lib/triage/work-items";

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    number: 42,
    projectId: null,
    title: "Fix the flaky login test",
    body: "",
    status: "triage",
    source: "app",
    sourceUrl: null,
    sourceRef: null,
    duplicateOf: null,
    workspaceId: null,
    triagedAt: null,
    createdAt: "2026-10-27T10:00:00Z",
    updatedAt: "2026-10-27T10:00:00Z",
    ...over,
  };
}

test("a title is the first line, without Markdown or Slack link marks, cut by character", () => {
  assert.equal(titleFromText("\n\n## Login is flaky\nmore"), "Login is flaky");
  assert.equal(titleFromText("- see <https://x.dev|the run>"), "see the run");
  assert.equal(titleFromText("**Bold** and [a link](https://x.dev)"), "Bold and a link");
  assert.equal(titleFromText("   "), "");
  const long = titleFromText("😀".repeat(100), 10);
  assert.equal(Array.from(long).length, 10);
  assert.ok(long.endsWith("…"));
});

test("a capture needs a title or a body, and only claims the sources the caller may", () => {
  assert.equal(parseNewWorkItem({}, ["app"]), "A title or a body is required.");
  const parsed = parseNewWorkItem({ body: "Fix it\n\nIt fails on Safari." }, ["app"]);
  assert.ok(typeof parsed !== "string");
  assert.equal(parsed.title, "Fix it");
  assert.equal(parsed.source, "app");
  assert.equal(typeof parseNewWorkItem({ title: "x", source: "slack" }, ["cli", "api"]), "string");
  const cli = parseNewWorkItem({ title: "x", project: " acme/web ", source_ref: "ci:123" }, ["cli", "api"]);
  assert.ok(typeof cli !== "string");
  assert.deepEqual([cli.source, cli.project, cli.sourceRef], ["cli", "acme/web", "ci:123"]);
});

test("only http(s) source links are kept", () => {
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("https://acme.slack.com/archives/C1/p1"), "https://acme.slack.com/archives/C1/p1");
  const parsed = parseNewWorkItem({ title: "x", source_url: "javascript:alert(1)" }, ["app"]);
  assert.ok(typeof parsed !== "string");
  assert.equal(parsed.sourceUrl, null);
});

test("a change is checked: a known status, a duplicate names its original", () => {
  assert.equal(parseWorkItemPatch({}), "Nothing to change.");
  assert.equal(parseWorkItemPatch({ status: "wontfix" }), "Unknown status.");
  assert.equal(parseWorkItemPatch({ status: "duplicate" }), "Pick the item this duplicates.");
  assert.equal(parseWorkItemPatch({ title: "  " }), "The title can't be empty.");
  assert.deepEqual(parseWorkItemPatch({ status: "todo", projectId: null }), { status: "todo", projectId: null });
  assert.deepEqual(parseWorkItemPatch({ status: "duplicate", duplicateOf: "x" }), {
    status: "duplicate",
    duplicateOf: "x",
  });
});

test("a note needs text", () => {
  assert.equal(parseNoteBody("  "), null);
  assert.equal(parseNoteBody(3), null);
  assert.equal(parseNoteBody(" ok "), "ok");
});

test("a session's prompt carries the key, body and notes, with who wrote them", () => {
  const note = (body: string, author: string | null): WorkItemNote => ({
    id: body,
    itemId: "i",
    body,
    source: "slack",
    sourceUrl: null,
    author,
    createdAt: "2026-10-27T10:00:00Z",
  });
  const prompt = workItemPrompt(item({ body: "Fails on Safari." }), [note("Also Firefox", "@ana (#eng)"), note("Seen twice\nin CI", null)], "https://app/triage?item=1");
  assert.equal(
    prompt,
    [
      "Work on OR-42: Fix the flaky login test",
      "(https://app/triage?item=1)",
      "Fails on Safari.",
      "Notes:\n- Also Firefox (@ana (#eng))\n- Seen twice\n  in CI",
    ].join("\n\n"),
  );
  assert.equal(itemKey(item()), "OR-42");
});

test("a tab's items group by workspace, Unsorted first, the rest by name", () => {
  const items = [
    item({ id: "a", projectId: "p2" }),
    item({ id: "b" }),
    item({ id: "c", projectId: "p1", status: "todo" }),
    item({ id: "d", projectId: "p1" }),
    item({ id: "e", projectId: "gone" }),
  ];
  const projects = [
    { id: "p1", fullName: "acme/api" },
    { id: "p2", fullName: "acme/web" },
  ];
  const groups = groupWorkItems(items, projects, "triage");
  assert.deepEqual(
    groups.map((g) => [g.label, g.items.map((i) => i.id)]),
    [
      ["Unsorted", ["b"]],
      ["acme/api", ["d"]],
      ["acme/web", ["a"]],
      ["Workspace", ["e"]],
    ],
  );
  assert.deepEqual(tabCounts(items), { triage: 4, backlog: 1, closed: 0 });
});
