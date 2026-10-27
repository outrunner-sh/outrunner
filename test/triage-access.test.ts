import assert from "node:assert/strict";
import { test } from "node:test";

import type { AccessLevel } from "@/lib/orgs/access";
import { canCapture, canMoveTo, canSee, canTriage, permissionsFor, type TriageActor } from "@/lib/triage/access";

function actor(orgLevel: AccessLevel | null, levels: Record<string, AccessLevel>): TriageActor {
  return { userId: "u", orgId: "o", orgLevel, levels: new Map(Object.entries(levels)) };
}

const web = { projectId: "web" };
const api = { projectId: "api" };
const unsorted = { projectId: null };

test("read on a workspace sees its items and contributes, but doesn't triage them", () => {
  const reader = actor(null, { web: "read" });
  assert.deepEqual(permissionsFor(reader, web), { triage: false, contribute: true });
  assert.equal(canSee(reader, api), false);
  assert.deepEqual(permissionsFor(reader, api), { triage: false, contribute: false });
});

test("write on a workspace triages its items", () => {
  const writer = actor("read", { web: "write", api: "read" });
  assert.equal(canTriage(writer, web), true);
  assert.equal(canTriage(writer, api), false);
});

test("Unsorted is every member's to see; triaging it needs write on all workspaces", () => {
  assert.deepEqual(permissionsFor(actor(null, {}), unsorted), { triage: false, contribute: true });
  assert.deepEqual(permissionsFor(actor("read", {}), unsorted), { triage: false, contribute: true });
  assert.deepEqual(permissionsFor(actor("write", {}), unsorted), { triage: true, contribute: true });
});

test("capturing needs read where it's filed; moving needs write where it goes", () => {
  const member = actor("read", { web: "write", api: "read" });
  assert.equal(canCapture(member, null), true);
  assert.equal(canCapture(member, "api"), true);
  assert.equal(canCapture(member, "secret"), false);
  assert.equal(canMoveTo(member, "web"), true);
  assert.equal(canMoveTo(member, "api"), false);
  assert.equal(canMoveTo(member, null), false);
  assert.equal(canMoveTo(actor("write", {}), null), true);
});
