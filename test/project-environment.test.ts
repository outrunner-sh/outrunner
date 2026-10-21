import assert from "node:assert/strict";
import { test } from "node:test";

import { deliverProjectEnvironment } from "@/lib/runtime/project-environment";

function box(features: string[]) {
  const sent: unknown[] = [];
  return {
    sent,
    client: {
      features: async () => features,
      setEnvironment: async (req: unknown) => {
        sent.push(req);
      },
    },
  };
}

const environment = {
  env: { API_TOKEN: "tok" },
  files: { "api/.env": "DATABASE_URL=x\n" },
  setup: "pnpm install",
  run: null,
  archive: null,
};

test("a project's variables and setup reach a box that takes them", async () => {
  const b = box(["session-environment"]);
  await deliverProjectEnvironment(b.client, environment);
  assert.deepEqual(b.sent, [{ env: { API_TOKEN: "tok" }, files: { "api/.env": "DATABASE_URL=x\n" }, setup: "pnpm install" }]);
});

test("nothing is sent for no environment, and an old box launches without it", async () => {
  for (const [features, env] of [
    [["session-environment"], null],
    [["session-environment"], { env: {}, files: {}, setup: null, run: null, archive: null }],
    [[], environment],
  ] as const) {
    const b = box([...features]);
    await deliverProjectEnvironment(b.client, env);
    assert.deepEqual(b.sent, []);
  }
});
