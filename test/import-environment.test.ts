import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ImportError } from "@/lib/imports/commit";
import { importEnvironment, RESERVED_ENV } from "@/lib/imports/environment";

const fixtures = JSON.parse(readFileSync(path.join(process.cwd(), "lib/runtime/agent-protocol.fixtures.json"), "utf8"));

test("the variables left out are the ones the agent refuses", () => {
  assert.deepEqual([...RESERVED_ENV].sort(), [...fixtures.ReservedEnv[0]].sort());
});

test("a repository's picked environment is kept for its project, less what a session can't set", async () => {
  const merged: unknown[] = [];
  const result = await importEnvironment(
    {
      repo: "ada/app",
      env: { APP_TOKEN: "tok", PATH: "/evil", RUNTIME_AGENT_SECRET: "x", "dotted.name": "y" },
      files: { "api/.env": "DATABASE_URL=x\n" },
      scripts: { setup: "pnpm install" },
    },
    {
      projectFor: async (repo) => (repo === "ada/app" ? "p-1" : null),
      merge: async (projectId, add) => {
        merged.push([projectId, add]);
      },
    },
  );
  assert.deepEqual(result, { projectId: "p-1", refused: ["PATH", "RUNTIME_AGENT_SECRET", "dotted.name"] });
  assert.deepEqual(merged, [
    ["p-1", { env: { APP_TOKEN: "tok" }, files: { "api/.env": "DATABASE_URL=x\n" }, scripts: { setup: "pnpm install" } }],
  ]);
});

test("a repository the user can't see, or an environment too large, is refused unsaved", async () => {
  let merges = 0;
  const deps = { projectFor: async () => null, merge: async () => void merges++ };
  await assert.rejects(importEnvironment({ repo: "bob/private", env: {}, files: {} }, deps), (e: unknown) => e instanceof ImportError && e.status === 404);
  const big = { repo: "ada/app", env: {}, files: { ".env": "x".repeat(1024 * 1024 + 1) } };
  await assert.rejects(importEnvironment(big, { ...deps, projectFor: async () => "p-1" }), (e: unknown) => e instanceof ImportError && e.status === 413);
  assert.equal(merges, 0);
});
