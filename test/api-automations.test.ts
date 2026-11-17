import assert from "node:assert/strict";
import { test } from "node:test";

import { automationBody, automationsList, automationsPage, modelFromSelection } from "@/lib/api/automations";
import { parseAutomationInput } from "@/lib/automations/rules";

test("Cursor's modelSelection is read as the automation's model, its effort from its parameters", () => {
  assert.deepEqual(automationBody({ modelSelection: { modelId: "opus", parameters: [{ id: "effort", value: "max" }] } }), {
    model: { id: "opus", effort: "max" },
  });
  for (const id of ["reasoning_effort", "thinking"]) {
    assert.deepEqual(modelFromSelection({ modelId: "opus", parameters: [{ id: "other", value: "x" }, { id, value: "low" }] }), {
      id: "opus",
      effort: "low",
    });
  }
  // snake_case at the top, as the API takes every field.
  assert.deepEqual(automationBody({ model_selection: { model_id: "sonnet" }, max_runs: 3 }), { model: { id: "sonnet" }, maxRuns: 3 });
  // Null, or one of Cursor's own ids: none of its own.
  assert.deepEqual(automationBody({ modelSelection: null }), { model: null });
  assert.deepEqual(automationBody({ modelSelection: { modelId: "default" } }), { model: null });
  // The automation's own `model` passes as it is.
  assert.deepEqual(automationBody({ model: { provider: "claude", id: "opus" } }), { model: { provider: "claude", id: "opus" } });
});

test("what Cursor's modelSelection can't be is refused, saying why", () => {
  for (const [what, body] of [
    ["both", { model: { id: "opus" }, modelSelection: { modelId: "opus" } }],
    ["no id", { modelSelection: { parameters: [] } }],
    ["a string", { modelSelection: "opus" }],
    ["parameters not a list", { modelSelection: { modelId: "opus", parameters: { effort: "max" } } }],
  ] as const) {
    assert.equal(typeof automationBody(body), "string", what);
  }
});

test("a body read from Cursor's is checked as the Automations page's is", () => {
  const body = automationBody({ modelSelection: { modelId: "opus", parameters: [{ id: "effort", value: "high" }] } });
  assert.ok(typeof body !== "string");
  assert.deepEqual(parseAutomationInput(body, { full: false }), {
    ok: true,
    value: { model: { provider: "claude", id: "opus", effort: "high" } },
  });
  const huge = automationBody({ modelSelection: { modelId: "opus", parameters: [{ id: "effort", value: "huge" }] } });
  assert.equal(parseAutomationInput(huge, { full: false }).ok, false);
});

test("the list answers in the API's pages and Cursor's, and takes either's paging", () => {
  const items = [1, 2, 3, 4, 5];
  const page = automationsPage(new URLSearchParams("limit=2&cursor=2"));
  assert.deepEqual(page, { page: 2, perPage: 2 });
  assert.ok(typeof page !== "string");
  assert.deepEqual(automationsList(items, page), {
    data: [3, 4],
    page: 2,
    per_page: 2,
    total: 5,
    total_pages: 3,
    has_more: true,
    items: [3, 4],
    nextCursor: "3",
  });
  // The last page has no nextCursor.
  const last = automationsList(items, { page: 3, perPage: 2 });
  assert.deepEqual(last.items, [5]);
  assert.equal("nextCursor" in last, false);
  // The API's own paging, as before; it wins over Cursor's when both are sent.
  assert.deepEqual(automationsPage(new URLSearchParams("page=2&per_page=3")), { page: 2, perPage: 3 });
  assert.deepEqual(automationsPage(new URLSearchParams("per_page=3&limit=1")), { page: 1, perPage: 3 });
  assert.deepEqual(automationsPage(new URLSearchParams("")), { page: 1, perPage: 20 });
  assert.equal(typeof automationsPage(new URLSearchParams("limit=500")), "string");
  assert.equal(typeof automationsPage(new URLSearchParams("cursor=abc")), "string");
});
