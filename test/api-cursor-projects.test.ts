import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appearanceFrom,
  cursorProjectJson,
  cursorProjectStatus,
  includeArchived,
  missionIdOf,
  projectFromCursor,
  projectPatchFromCursor,
  projectTitle,
  type ProjectCreate,
} from "@/lib/api/cursor-projects";

const ICONS = ["rocket", "compass", "flag"];
const ID = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";

function create(raw: Record<string, unknown>): ProjectCreate {
  const made = projectFromCursor(raw, ICONS);
  assert.notEqual(typeof made, "string", String(made));
  return made as ProjectCreate;
}

test("a project's status is its session's: archived, or active", () => {
  assert.equal(cursorProjectStatus("archived"), "ARCHIVED");
  assert.equal(cursorProjectStatus("archiving"), "ARCHIVED");
  for (const status of ["creating", "provisioning", "ready", "idle", "suspended", "failed"]) assert.equal(cursorProjectStatus(status), "ACTIVE");
});

test("a project's id names its Mission, with or without bc-", () => {
  assert.equal(missionIdOf(`bc-${ID}`), ID);
  assert.equal(missionIdOf(ID), ID);
});

test("a Mission said as Cursor's project: its own session is its coordinator", () => {
  const json = cursorProjectJson(
    { id: ID, title: "Billing revamp", status: "idle", createdAt: "2026-11-17T10:00:00Z", updatedAt: "2026-11-17T11:00:00Z" },
    { icon: "rocket", url: `https://outrunner.sh/workspaces/${ID}` },
  );
  assert.deepEqual(json, {
    id: ID,
    name: "Billing revamp",
    status: "ACTIVE",
    appearance: { icon: "rocket", color: "default" },
    coordinatorAgentId: ID,
    createdAt: "2026-11-17T10:00:00Z",
    updatedAt: "2026-11-17T11:00:00Z",
    url: `https://outrunner.sh/workspaces/${ID}`,
  });
  const untitled = cursorProjectJson({ id: ID, title: null, status: "archived", createdAt: "a", updatedAt: "b" }, { icon: null, url: "u" });
  assert.equal(untitled.name, "New Mission");
  assert.equal(untitled.status, "ARCHIVED");
});

test("a create on a repository: its prompt, model, effort and starting branch", () => {
  const made = create({
    prompt: { text: "Own the billing area" },
    model: { id: "claude-opus-4-5", params: [{ id: "effort", value: "high" }] },
    name: "  Billing   revamp ",
    repos: [{ url: "https://github.com/acme/web", startingRef: "develop" }],
    appearance: { icon: "compass", color: "green" },
    projectId: `bc-${ID}`,
  });
  assert.equal(made.prompt, "Own the billing area");
  assert.equal(made.model, "claude-opus-4-5");
  assert.equal(made.effort, "high");
  assert.equal(made.name, "Billing revamp");
  assert.equal(made.startingRef, "develop");
  assert.deepEqual(made.place, { repoFullName: "acme/web" });
  assert.deepEqual(made.appearance, { icon: "compass", color: "green" });
  assert.equal(made.key, `bc-${ID}`);
  assert.deepEqual(made.images, []);
});

test("a create names its project by env.name, or Outrunner's own ids", () => {
  assert.deepEqual(create({ prompt: "Go", env: { type: "cloud", name: "Monorepo" } }).place, { envName: "Monorepo" });
  assert.deepEqual(create({ prompt: "Go", environment_id: ID }).place, { environmentId: ID });
  assert.deepEqual(create({ prompt: "Go", project_id: ID }).place, { projectId: ID });
});

test("a create's prompt may be left out: the Mission waits for one", () => {
  const made = create({ repos: [{ url: "github.com/acme/web" }], name: "Docs" });
  assert.equal(made.prompt, "");
  assert.equal(projectTitle(made), "Docs");
  assert.equal(projectTitle(create({ repos: [{ url: "acme/web" }] })), undefined);
  assert.equal(projectTitle(create({ prompt: "Keep the docs current. Every week.", repos: [{ url: "acme/web" }] })), "Keep the docs current");
});

test("a Cursor-only model starts on the caller's default", () => {
  assert.equal(create({ prompt: "Go", model: { id: "composer-1" }, repos: [{ url: "acme/web" }] }).model, undefined);
});

test("refused creates say why", () => {
  const refused = (raw: Record<string, unknown>) => {
    const made = projectFromCursor(raw, ICONS);
    assert.equal(typeof made, "string", JSON.stringify(raw));
    return made as string;
  };
  assert.match(refused({ prompt: "Go", repos: [{ url: "acme/web" }, { url: "acme/api" }] }), /env: \{ type: "cloud", name \}/);
  assert.match(refused({ prompt: "Go" }), /Say where the project works/);
  assert.match(refused({ prompt: "Go", repos: [{ url: "acme/web" }], environment_id: ID }), /one place/);
  assert.match(refused({ prompt: "Go", env: { type: "cloud", name: "Mono" }, repos: [{ url: "acme/web" }] }), /not both/);
  assert.match(refused({ prompt: "Go", env: { type: "pool" }, repos: [{ url: "acme/web" }] }), /env.type: cloud/);
  assert.match(refused({ prompt: "Go", repos: [{ url: "https://example.com/acme/web" }] }), /repos\[0\]\.url/);
  assert.match(refused({ prompt: "Go", repos: [{ url: "acme/web", prUrl: "https://github.com/acme/web/pull/3" }] }), /startingRef/);
  assert.match(refused({ prompt: "Go", repos: [{ url: "acme/web" }], agent: "codex" }), /Claude Code/);
  assert.match(refused({ prompt: "Go", repos: [{ url: "acme/web" }], provider: "codex" }), /Claude Code/);
  assert.match(refused({ prompt: "Go", repos: [{ url: "acme/web" }], appearance: { icon: "unicorn" } }), /rocket, compass, flag/);
  assert.match(refused({ prompt: "Go", repos: [{ url: "acme/web" }], appearance: { color: "teal" } }), /brand/);
  assert.match(refused({ prompt: "Go", repos: [{ url: "acme/web" }], projectId: "has space" }), /projectId/);
  assert.match(refused({ prompt: "Go", environment_id: "nope" }), /isn't one/);
  assert.match(refused({ prompt: "Go", env: { type: "cloud", name: "Mono" }, size: "huge" }), /size/);
  assert.match(refused({ prompt: "Go", repos: [{ url: "acme/web" }], name: "x".repeat(121) }), /120/);
});

test("appearance: an icon of the Mission's, a color of Cursor's", () => {
  assert.deepEqual(appearanceFrom(undefined, ICONS), {});
  assert.deepEqual(appearanceFrom({ icon: "flag" }, ICONS), { icon: "flag" });
  assert.deepEqual(appearanceFrom({ color: "brand" }, ICONS), { color: "brand" });
  assert.equal(typeof appearanceFrom("rocket", ICONS), "string");
});

test("a PATCH as the Mission's rename: its title and icon; a color alone changes nothing", () => {
  assert.deepEqual(projectPatchFromCursor({ name: " New  name ", appearance: { icon: "rocket", color: "red" } }, ICONS), { title: "New name", icon: "rocket" });
  assert.deepEqual(projectPatchFromCursor({ appearance: { color: "red" } }, ICONS), {});
  assert.equal(typeof projectPatchFromCursor({}, ICONS), "string");
  assert.equal(typeof projectPatchFromCursor({ name: "   " }, ICONS), "string");
  assert.equal(typeof projectPatchFromCursor({ appearance: { icon: "unicorn" } }, ICONS), "string");
});

test("includeArchived is true unless asked otherwise", () => {
  assert.equal(includeArchived(new URLSearchParams()), true);
  assert.equal(includeArchived(new URLSearchParams("includeArchived=false")), false);
  assert.equal(includeArchived(new URLSearchParams("includeArchived=true")), true);
  assert.equal(typeof includeArchived(new URLSearchParams("includeArchived=yes")), "string");
});
