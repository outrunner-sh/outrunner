import assert from "node:assert/strict";
import { test } from "node:test";

import { homeStart, initialProjectId } from "@/lib/session/initial-project";

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

const at = (projectId: string, lastActiveAt: string | null, createdAt = "2026-01-01T00:00:00Z", environmentId: string | null = null) => ({
  projectId,
  environmentId,
  lastActiveAt,
  createdAt,
});

const acme = { id: "env-acme", orgDefault: true };
const web = { id: "env-web", orgDefault: false };

test("home starts on the org's default environment, ahead of the most recent session", () => {
  const workspaces = [at("b", "2026-03-02T00:00:00Z", undefined, "env-web")];
  assert.deepEqual(homeStart([web, acme], projects, workspaces), { environmentId: "env-acme" });
});

test("with no default, home starts where the most recent session did: its environment when listed, else its repository", () => {
  assert.deepEqual(homeStart([web], projects, [at("a", "2026-03-01T00:00:00Z"), at("b", "2026-03-02T00:00:00Z", undefined, "env-web")]), {
    environmentId: "env-web",
  });
  // A repository's own environment isn't listed: the repository stands for it.
  assert.deepEqual(homeStart([web], projects, [at("b", "2026-03-02T00:00:00Z", undefined, "own-env-of-b")]), { projectId: "b" });
});

test("a session still provisioning (never active) ranks by when it was created", () => {
  const workspaces = [at("a", "2026-03-01T00:00:00Z"), at("b", null, "2026-03-05T00:00:00Z")];
  assert.deepEqual(homeStart([], projects, workspaces), { projectId: "b" });
});

test("recency compares instants, not text", () => {
  // As text, `12:00:00Z` sorts after `12:00:00.5+00:00`; as time it is earlier.
  const workspaces = [at("a", "2026-03-01T12:00:00.5+00:00"), at("b", "2026-03-01T12:00:00Z")];
  assert.deepEqual(homeStart([], projects, workspaces), { projectId: "a" });
});

test("with no sessions, home starts on the first environment, else the form's first repository", () => {
  assert.deepEqual(homeStart([web], projects, []), { environmentId: "env-web" });
  assert.equal(homeStart([], projects, []), undefined);
});

test("a most-recent session whose repository is not listed falls back, never picks another", () => {
  const workspaces = [at("a", "2026-03-01T00:00:00Z"), at("hidden", "2026-03-09T00:00:00Z")];
  assert.equal(homeStart([], projects, workspaces), undefined);
  assert.equal(homeStart([], [], [at("a", "2026-03-01T00:00:00Z")]), undefined);
});

test("home starts where a session was just refused, while that's listed, ahead of the default", () => {
  const workspaces = [at("a", "2026-03-01T00:00:00Z")];
  assert.deepEqual(homeStart([acme, web], projects, workspaces, { projectId: "b" }), { projectId: "b" });
  assert.deepEqual(homeStart([acme, web], projects, workspaces, { projectId: "b", environmentId: "env-web" }), { environmentId: "env-web" });
  // Gone from the list since: as without one.
  assert.deepEqual(homeStart([acme], projects, workspaces, { projectId: "gone", environmentId: "env-gone" }), { environmentId: "env-acme" });
  assert.deepEqual(homeStart([], projects, workspaces, { projectId: "gone" }), { projectId: "a" });
});
