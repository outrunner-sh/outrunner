import assert from "node:assert/strict";
import { test } from "node:test";

import { restoresOnOpen, restoreSession } from "@/lib/session/restore-session";

test("only an archived session on a Runtime Computer restores as it opens", () => {
  assert.equal(restoresOnOpen({ status: "archived", provider: "daytona" }), true);
  assert.equal(restoresOnOpen({ status: "archived", provider: "user-modal" }), true);
  // The legacy sandboxes have no Snapshot restore.
  assert.equal(restoresOnOpen({ status: "archived", provider: "modal" }), false);
  assert.equal(restoresOnOpen({ status: "archived", provider: "local" }), false);
  for (const status of ["ready", "restoring", "suspended", "failed"] as const) {
    assert.equal(restoresOnOpen({ status, provider: "daytona" }), false, status);
  }
});

test("a restore asks the lifecycle route once, however many times the page asks meanwhile", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  let answer!: (res: Response) => void;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Promise<Response>((resolve) => (answer = resolve));
  }) as typeof fetch;

  const first = restoreSession("ws-1", fetchImpl);
  const second = restoreSession("ws-1", fetchImpl);
  assert.equal(first, second);
  answer(new Response(JSON.stringify({ workspace: { id: "ws-1", status: "ready" } }), { status: 200 }));
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(calls, [{ url: "/api/workspaces/ws-1/lifecycle", body: { action: "restore" } }]);

  // Answered: the next open asks again.
  void restoreSession("ws-1", fetchImpl);
  assert.equal(calls.length, 2);
  answer(new Response("{}", { status: 200 }));
});

test("a refused restore says why, and where to fix it when the server names a page", async () => {
  const answering = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  assert.deepEqual(
    await restoreSession("ws-2", answering(409, { error: "Connect Claude in Settings.", settingsHref: "/settings/providers" })),
    { ok: false, error: "Connect Claude in Settings.", settingsHref: "/settings/providers" },
  );
  // A body without a sentence still says something.
  assert.deepEqual(await restoreSession("ws-3", answering(502, { nope: true })), {
    ok: false,
    error: "Could not restore this session. Please try again.",
    settingsHref: null,
  });
  const offline = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  assert.deepEqual(await restoreSession("ws-4", offline), {
    ok: false,
    error: "Could not reach Outrunner. Check your connection and try again.",
    settingsHref: null,
  });
});
