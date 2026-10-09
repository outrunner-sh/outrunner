import assert from "node:assert/strict";
import { test } from "node:test";

import { initialProjectId, lastSessionProjectId } from "@/lib/session/initial-project";

const projects = [{ id: "a" }, { id: "b" }];

test("with no repository requested, the form starts on the first", () => {
  assert.equal(initialProjectId(projects), "a");
  assert.equal(initialProjectId([]), "");
});

test("a requested repository that is listed is selected", () => {
  assert.equal(initialProjectId(projects, "b"), "b");
});

test("a requested repository that is not listed selects nothing, never another one", () => {
  assert.equal(initialProjectId(projects, "hidden"), "");
  assert.equal(initialProjectId(projects, ""), "");
  assert.equal(initialProjectId([], "b"), "");
});

const at = (projectId: string, lastActiveAt: string | null, createdAt = "2026-01-01T00:00:00Z") => ({
  projectId,
  lastActiveAt,
  createdAt,
});

test("home starts on the repository of the most recently active session", () => {
  const workspaces = [at("a", "2026-03-01T00:00:00Z"), at("b", "2026-03-02T00:00:00Z")];
  assert.equal(lastSessionProjectId(projects, workspaces), "b");
});

test("a session still provisioning (never active) ranks by when it was created", () => {
  const workspaces = [at("a", "2026-03-01T00:00:00Z"), at("b", null, "2026-03-05T00:00:00Z")];
  assert.equal(lastSessionProjectId(projects, workspaces), "b");
});

test("recency compares instants, not text", () => {
  // As text, `12:00:00Z` sorts after `12:00:00.5+00:00`; as time it is earlier.
  const workspaces = [at("a", "2026-03-01T12:00:00.5+00:00"), at("b", "2026-03-01T12:00:00Z")];
  assert.equal(lastSessionProjectId(projects, workspaces), "a");
});

test("with no sessions, home falls back to the form's default", () => {
  assert.equal(lastSessionProjectId(projects, []), undefined);
});

test("a most-recent session whose repository is not listed falls back, never picks another", () => {
  const workspaces = [at("a", "2026-03-01T00:00:00Z"), at("hidden", "2026-03-09T00:00:00Z")];
  assert.equal(lastSessionProjectId(projects, workspaces), undefined);
  assert.equal(lastSessionProjectId([], [at("a", "2026-03-01T00:00:00Z")]), undefined);
});
