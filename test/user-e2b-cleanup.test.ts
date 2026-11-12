import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { Sandbox } from "e2b";

import { cleanUpUserE2b } from "@/lib/runtime/user-e2b-cleanup";

const original = { list: Sandbox.list, kill: Sandbox.kill, fetch: globalThis.fetch, base: process.env.RUNTIME_BASE_URL };
afterEach(() => {
  Object.assign(Sandbox, { list: original.list, kill: original.kill });
  globalThis.fetch = original.fetch;
  if (original.base === undefined) delete process.env.RUNTIME_BASE_URL;
  else process.env.RUNTIME_BASE_URL = original.base;
});

const USER = "0b8a3ded-4489-4722-afd1-1d82e64ec2d5";
const STORED = {
  ownerId: USER,
  apiKey: "e2b_user",
  apiUrl: null,
  sandboxUrl: null,
  template: "ready" as const,
  templateId: "tmpl-now",
  templateBuildId: "build-1",
  templateError: null,
};

test("disconnecting a user's E2B deletes this deployment's boxes and every Outrunner template there", async () => {
  process.env.RUNTIME_BASE_URL = "https://app.outrunner.test";
  let query: unknown;
  const killed: string[] = [];
  let page = 0;
  Object.assign(Sandbox, {
    list: (opts: { query?: unknown }) => {
      query = opts.query;
      return {
        get hasNext() {
          return page < 2;
        },
        nextItems: async () => (page++ === 0 ? [{ sandboxId: "sbx-1" }, { sandboxId: "sbx-2" }] : [{ sandboxId: "sbx-3" }]),
      };
    },
    kill: async (id: string) => {
      if (id === "sbx-2") throw new Error("busy");
      killed.push(id);
      return true;
    },
  });
  const deleted: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      deleted.push(String(url).split("/").pop()!);
      return new Response(null, { status: 204 });
    }
    return Response.json([
      { templateID: "tmpl-now", names: [`outrunner-box-aaaaaaaaaaaa-0b8a3ded`] },
      { templateID: "tmpl-old", names: [`outrunner-box-bbbbbbbbbbbb-0b8a3ded`] },
      { templateID: "theirs", names: ["my-own-template"] },
    ]);
  }) as typeof fetch;

  assert.deepEqual(await cleanUpUserE2b(USER, STORED), { boxes: 2, failed: 1 });
  assert.deepEqual(killed, ["sbx-1", "sbx-3"]);
  // Only Outrunner's boxes, of this deployment.
  assert.deepEqual((query as { metadata: unknown }).metadata, { "runtime.role": "computer", "runtime.deployment": "app.outrunner.test" });
  // Every one of the user's Outrunner templates, the current one too; never theirs.
  assert.deepEqual(deleted.sort(), ["tmpl-now", "tmpl-old"]);
});
