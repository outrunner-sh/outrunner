import assert from "node:assert/strict";
import { test } from "node:test";

import { warmNewSession } from "@/lib/session/warm-new-session";

test("composer intent asks once per project inside the warm window", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  try {
    warmNewSession("project-intent-test");
    warmNewSession("project-intent-test");
    await Promise.resolve();
    assert.deepEqual(calls, ["/api/projects/project-intent-test/warm"]);
  } finally {
    globalThis.fetch = original;
  }
});
