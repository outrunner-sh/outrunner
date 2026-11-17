import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cursorBuildJson,
  cursorEnvironmentJson,
  environmentJsonOf,
  historyItemJson,
  hooksFromEnvironmentJson,
  projectSecretJson,
  repoNamesOf,
  secretPutOf,
  secretVersionJson,
} from "@/lib/api/cursor-environments";
import type { Environment } from "@/lib/db/environments";

const project: Environment = {
  id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427",
  orgId: "org",
  name: "Web + API",
  description: null,
  instructions: null,
  repos: [
    { projectId: "p1", fullName: "acme/web", checkoutName: "web", branch: null, defaultBranch: "main", position: 0, private: true },
    { projectId: "p2", fullName: "gitlab.com/acme/api", checkoutName: "api", branch: "develop", defaultBranch: "main", position: 1, private: true },
  ],
  envNames: ["STRIPE_KEY"],
  filePaths: [],
  scripts: { setup: null, run: null, archive: null },
  hooks: { warm: "pnpm install", start: null },
  defaultForProjectId: null,
  setupGeneration: 4,
  warm: { status: "succeeded", log: null, startedAt: "t1", finishedAt: "t2", generation: 4 },
  updatedAt: "t3",
  createdAt: "t0",
  access: "write",
};

test("environmentJson's install is the warm hook, start the start hook with its terminals in the background", () => {
  assert.deepEqual(hooksFromEnvironmentJson('{"install":"pnpm install","start":"docker compose up -d"}'), { warm: "pnpm install", start: "docker compose up -d" });
  const hooks = hooksFromEnvironmentJson({ terminals: [{ name: "web dev", command: "pnpm dev" }] });
  assert.ok(typeof hooks !== "string");
  assert.equal(hooks.warm, null);
  assert.equal(hooks.start, "nohup sh -c 'pnpm dev' > /tmp/terminal-web-dev.log 2>&1 &");
  assert.deepEqual(hooksFromEnvironmentJson("{}"), { warm: null, start: null });
  assert.match(hooksFromEnvironmentJson("{nope") as string, /is JSON/);
  assert.match(hooksFromEnvironmentJson({ build: { dockerfileContents: "FROM x" } }) as string, /box image/);
  assert.match(hooksFromEnvironmentJson({ install: ["a"] }) as string, /shell command/);
  assert.equal(environmentJsonOf({ warm: "pnpm install", start: null }), '{"install":"pnpm install"}');
});

test("a project reads as Cursor's environment; in full with its environmentJson", () => {
  assert.deepEqual(cursorEnvironmentJson(project, false, false), {
    id: project.id,
    name: "Web + API",
    owner: "team",
    repos: [{ url: "https://github.com/acme/web" }, { url: "https://gitlab.com/acme/api" }],
    createdAt: "t0",
    updatedAt: "t3",
  });
  const full = cursorEnvironmentJson(project, true, true);
  assert.equal(full.owner, "personal");
  assert.equal(full.environmentJson, '{"install":"pnpm install"}');
  assert.equal(full.versionId, "gen-4");
});

test("its build is its ready boxes' latest making", () => {
  const build = cursorBuildJson(project);
  assert.equal(build?.id, "bld-4");
  assert.equal(build?.status, "SUCCEEDED");
  assert.deepEqual(build?.requestedRefs, [{ repoUrl: "github.com/acme/web", ref: "main" }, { repoUrl: "gitlab.com/acme/api", ref: "develop" }]);
  assert.equal(build?.completedAt, "t2");
  assert.equal(cursorBuildJson({ ...project, warm: { ...project.warm!, status: "failed" } })?.status, "FAILED");
  // A change since its warm hook last ran: being made again.
  assert.equal(cursorBuildJson({ ...project, setupGeneration: 5 })?.status, "IN_PROGRESS");
  assert.equal(cursorBuildJson({ ...project, hooks: { warm: null, start: null }, warm: null })?.status, "SKIPPED");
});

test("a change in its history says what it was, with the hooks it left", () => {
  const event = { id: 9, actorType: "user" as const, actorId: "u", actorLabel: "ada", action: "project.changed", resourceType: "environment", resourceId: project.id, resourceLabel: "Web", details: { fields: ["hooks"], hooks: { warm: "bun i", start: null } }, createdAt: "t" };
  assert.deepEqual(historyItemJson(event, "changed the project Web's hooks", true), {
    id: "9",
    createdAt: "t",
    kind: "updated",
    title: "ada changed the project Web's hooks",
    description: "changed the project Web's hooks",
    source: "API",
    current: true,
    environmentJson: '{"install":"bun i"}',
  });
  assert.equal(historyItemJson({ ...event, action: "project.secrets_changed", details: {} }, "x", false).kind, "changed");
});

test("repos and secrets are checked as Cursor sends them", () => {
  assert.deepEqual(repoNamesOf([{ url: "https://github.com/acme/web" }, "gitlab.com/acme/api"]), ["acme/web", "gitlab.com/acme/api"]);
  assert.match(repoNamesOf([]) as string, /at least one/);
  assert.match(repoNamesOf([{ url: "https://example.com/x" }]) as string, /GitHub or GitLab/);
  assert.deepEqual(secretPutOf({ value: "s3cret", type: "environment_variable", repos: ["https://github.com/Acme/Web"] }), {
    value: "s3cret",
    type: "environment_variable",
    repos: ["acme/web"],
  });
  assert.match(secretPutOf({ value: "" }) as string, /1 to 4096/);
  assert.match(secretPutOf({ value: "x", type: "build_secret" }) as string, /Build secrets/);
  assert.match(secretPutOf({ value: "x", repos: ["not a repo"] }) as string, /address/);
});

test("secrets list by name, never a value, with whose they are", () => {
  const secret = { id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", name: "NPM_TOKEN", type: "runtime_secret" as const, repos: [], createdAt: "t", updatedAt: "t" };
  assert.deepEqual(secretVersionJson(secret, { type: "team" }), {
    id: "secv_1b4e28ba2fa111d2883f0016d3cca427",
    name: "NPM_TOKEN",
    type: "runtime_secret",
    repos: [],
    createdAt: "t",
    owner: { type: "team" },
  });
  assert.deepEqual(projectSecretJson(project, "STRIPE_KEY", true).owner, { type: "environment", environmentId: project.id });
  assert.equal("value" in projectSecretJson(project, "STRIPE_KEY"), false);
});
