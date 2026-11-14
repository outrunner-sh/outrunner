import assert from "node:assert/strict";
import { test } from "node:test";

import { firstPrompt, idempotencyKey, idempotentId, parseAttachmentIds, parseCreate, PLAN_MODE_PREAMBLE } from "@/lib/api/create-request";
import { isUuid } from "@/lib/ids";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/runtime/attachments";

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

test("files go with the prompt by their upload ids, as many as one message takes", () => {
  const file = "11111111-1111-4111-8111-111111111111";
  const input = parseCreate({ project_id: PROJECT, prompt: "look", attachment_ids: [file, file] });
  assert.ok(typeof input !== "string");
  assert.deepEqual(input.attachmentIds, [file]);
  assert.deepEqual((parseCreate({ project_id: PROJECT, prompt: "x" }) as { attachmentIds: string[] }).attachmentIds, []);
  assert.equal(typeof parseCreate({ project_id: PROJECT, prompt: "x", attachment_ids: "abc" }), "string");
  assert.equal(typeof parseAttachmentIds(["not-an-id"]), "string");
  const many = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`);
  assert.match(parseAttachmentIds(many) as string, /Up to/);
  assert.deepEqual(parseAttachmentIds(null), []);
});

test("an Idempotency-Key makes the same session id for its caller, and only theirs", () => {
  const id = idempotentId("user-a", "deploy-42");
  assert.ok(isUuid(id));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(idempotentId("user-a", "deploy-42"), id);
  assert.notEqual(idempotentId("user-b", "deploy-42"), id);
  assert.notEqual(idempotentId("user-a", "deploy-43"), id);
  assert.equal(idempotencyKey(new Headers()), null);
  assert.equal(idempotencyKey(new Headers({ "idempotency-key": "run-7" })), "run-7");
  assert.deepEqual(typeof idempotencyKey(new Headers({ "idempotency-key": "has space" })), "object");
  assert.deepEqual(typeof idempotencyKey(new Headers({ "idempotency-key": "x".repeat(256) })), "object");
});
