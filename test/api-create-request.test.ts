import assert from "node:assert/strict";
import { test } from "node:test";

import { firstPrompt, parseCreate, PLAN_MODE_PREAMBLE } from "@/lib/api/create-request";

const PROJECT = "11111111-1111-4111-8111-111111111111";

test("a create names a repository or a project, and a prompt", () => {
  const input = parseCreate({ project_id: PROJECT, prompt: " fix the build ", model: "sonnet", size: "large" });
  assert.equal(typeof input, "object");
  assert.equal(typeof input !== "string" && input.prompt, "fix the build");
  assert.equal(typeof input !== "string" && input.size, "large");
  assert.equal(typeof parseCreate({ prompt: "x" }), "string");
  assert.equal(typeof parseCreate({ project_id: PROJECT }), "string");
  assert.equal(typeof parseCreate({ project_id: PROJECT, environment_id: PROJECT, prompt: "x" }), "string");
  assert.equal(typeof parseCreate({ project_id: "nope", prompt: "x" }), "string");
});

test("what it may ask for is checked", () => {
  assert.equal(typeof parseCreate({ project_id: PROJECT, prompt: "x", size: "huge" }), "string");
  assert.equal(typeof parseCreate({ project_id: PROJECT, prompt: "x", agent: "gemini", model: "m" }), "string");
  assert.equal(typeof parseCreate({ project_id: PROJECT, prompt: "x", agent: "codex" }), "string");
  assert.equal(typeof parseCreate({ project_id: PROJECT, prompt: "x", plan_mode: "yes" }), "string");
  assert.equal(typeof parseCreate({ project_id: PROJECT, prompt: "x", model: 5 }), "string");
});

test("plan mode asks for a plan before the task", () => {
  assert.equal(firstPrompt({ prompt: "do it", planMode: false }), "do it");
  assert.equal(firstPrompt({ prompt: "do it", planMode: true }), `${PLAN_MODE_PREAMBLE}\n\ndo it`);
});
