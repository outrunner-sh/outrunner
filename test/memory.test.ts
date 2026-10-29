import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addMemory,
  deleteMemory,
  listMemories,
  MAX_MEMORIES,
  type Memory,
  type MemoryActor,
  MemoryError,
  memoryRights,
  type MemoryStore,
  parseMemoryBody,
} from "@/lib/memory/actions";
import { MAX_MEMORY_SECTION_CHARS, renderAgentContext } from "@/lib/runtime/agent-context";
import { callSessionTool } from "@/lib/session-tools/tools";

const ORG = "00000000-0000-0000-0000-0000000000b1";
const admin: MemoryActor = { userId: "u-admin", orgId: ORG, role: "admin" };
const ada: MemoryActor = { userId: "u-ada", orgId: ORG, role: "member" };
const bo: MemoryActor = { userId: "u-bo", orgId: ORG, role: "member" };

function store(): MemoryStore & { rows: Memory[] } {
  const rows: Memory[] = [];
  let n = 0;
  return {
    rows,
    list: async (where) =>
      rows
        .filter((m) => ("orgId" in where ? m.orgId === where.orgId : m.userId === where.userId && m.orgId === null))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    get: async (id) => rows.find((m) => m.id === id) ?? null,
    insert: async (row) => {
      n++;
      const memory: Memory = {
        id: `m-${n}`,
        scope: row.orgId ? "org" : "personal",
        ...row,
        createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString(),
      };
      rows.push(memory);
      return memory;
    },
    remove: async (id) => {
      const i = rows.findIndex((m) => m.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
  };
}

test("a note is short text, and never a secret", () => {
  assert.equal(parseMemoryBody("  Tests run with pnpm test:unit.\n\n\n\nNot pnpm test. "), "Tests run with pnpm test:unit.\n\nNot pnpm test.");
  assert.ok(typeof parseMemoryBody("") !== "string");
  assert.ok(typeof parseMemoryBody("x".repeat(1001)) !== "string");
  for (const secret of [
    "The key is sk-ant-api03-abcdefghijklmnopqrstuvwx",
    "use ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "AWS AKIAABCDEFGHIJKLMNOP works",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  ]) {
    const parsed = parseMemoryBody(secret);
    assert.ok(typeof parsed !== "string" && /secret/.test(parsed.error), secret);
  }
  // Talking about where a key lives is fine.
  assert.equal(parseMemoryBody("The Stripe key is STRIPE_SECRET_KEY in Doppler."), "The Stripe key is STRIPE_SECRET_KEY in Doppler.");
});

test("a person's notes are theirs; the org's are everyone's to read and their writer's or an admin's to delete", async () => {
  const s = store();
  const own = await addMemory(ada, s, { scope: "personal", body: "I prefer small PRs.", workspaceId: "ws-1" });
  const shared = await addMemory(ada, s, { scope: "org", body: "CI runs on Node 22." });

  assert.deepEqual((await listMemories(ada, s)).map((m) => m.body), ["I prefer small PRs.", "CI runs on Node 22."]);
  assert.deepEqual((await listMemories(bo, s)).map((m) => m.body), ["CI runs on Node 22."]);
  assert.deepEqual((await listMemories(ada, s, { query: "node ci" })).map((m) => m.body), ["CI runs on Node 22."]);
  assert.deepEqual(memoryRights(bo, shared), { read: true, delete: false });
  assert.deepEqual(memoryRights(admin, shared), { read: true, delete: true });
  assert.deepEqual(memoryRights(admin, own), { read: false, delete: false });

  await assert.rejects(deleteMemory(bo, s, shared.id), (e) => e instanceof MemoryError && e.status === 403);
  await assert.rejects(deleteMemory(admin, s, own.id), (e) => e instanceof MemoryError && e.status === 404);
  await deleteMemory(admin, s, shared.id);
  await deleteMemory(ada, s, own.id);
  assert.equal(s.rows.length, 0);
});

test("the same note twice is kept once, and a full memory says so", async () => {
  const s = store();
  const first = await addMemory(ada, s, { scope: "personal", body: "Use pnpm." });
  assert.equal((await addMemory(ada, s, { scope: "personal", body: " Use pnpm. " })).id, first.id);
  for (let i = s.rows.length; i < MAX_MEMORIES; i++) await addMemory(ada, s, { scope: "personal", body: `note ${i}` });
  await assert.rejects(addMemory(ada, s, { scope: "personal", body: "one more" }), (e) => e instanceof MemoryError && e.status === 409);
});

test("a session loads the newest notes that fit, after its learnings", async () => {
  const s = store();
  await addMemory(ada, s, { scope: "personal", body: "Old note." });
  await addMemory(ada, s, { scope: "org", body: "Deploys go out on Tuesdays." });
  const memory = await listMemories(ada, s);
  memory.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const block = renderAgentContext({ orgName: "Acme", learnings: { org: [], personal: [] }, memory });
  assert.match(block, /^# Outrunner memory/);
  assert.match(block, /- 2026-11-01 \(the org's\): Deploys go out on Tuesdays\.\n- 2026-11-01: Old note\./);

  const many = Array.from({ length: 400 }, (_, i) => ({ ...memory[0], id: `x${i}`, body: `note ${i} ${"x".repeat(60)}` }));
  const cut = renderAgentContext({ orgName: null, learnings: { org: [], personal: [] }, memory: many });
  assert.ok(cut.length <= MAX_MEMORY_SECTION_CHARS + 100);
  assert.match(cut, /older notes not shown here/);
});

test("an agent reads and adds to its user's memory through its session's commands", async () => {
  const s = store();
  const deps = {
    actor: async (userId: string) => (userId === "u-ada" ? ada : null),
    learnings: { store: { list: async () => [], get: async () => null, insert: async () => assert.fail(), update: async () => null, remove: async () => false } },
    memory: s,
    base: "https://app.outrunner.sh",
  };
  const scope = { userId: "u-ada", orgId: ORG, workspaceId: "ws-9" };
  assert.equal((await callSessionTool(scope, "read_memory", {}, deps)).text, "Memory is empty.");
  const kept = await callSessionTool(scope, "remember", { body: "Tests need Postgres on 5433." }, deps);
  assert.equal(kept.status, 201);
  assert.equal(s.rows[0].workspaceId, "ws-9");
  assert.equal(s.rows[0].orgId, null);
  await callSessionTool(scope, "remember", { scope: "org", body: "Staging is staging.acme.dev." }, deps);
  const read = await callSessionTool(scope, "read_memory", { query: "postgres" }, deps);
  assert.match(read.text ?? "", /^- 2026-11-01: Tests need Postgres on 5433\.$/);
  const secret = await callSessionTool(scope, "remember", { body: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, deps);
  assert.equal(secret.status, 400);
  assert.equal((await callSessionTool(scope, "remember", { scope: "everyone", body: "x" }, deps)).status, 400);
});
