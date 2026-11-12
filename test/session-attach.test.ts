import assert from "node:assert/strict";
import { test } from "node:test";
import { AttachError, attachCloudSession, retryableAttachFailure } from "@/lib/session/attach-session";
import { BOX_GONE, BOX_RESTORE_FAILED, SESSION_ENDED, SESSION_NOT_STARTED } from "@/lib/session/session-codes";

const urls = { ptyUrl: "wss://box/pty", eventsUrl: "wss://box/events" };
const reply = (status: number, code?: string) => Response.json({ error: "Box is waking", ...(code && { code }) }, { status });

test("a brief box recovery failure retries with fresh endpoints and keeps its chat", async () => {
  const asked: string[] = [];
  const delays: number[] = [];
  const result = await attachCloudSession("w", "chat-1", false, new AbortController().signal, {
    fetch: async (url) => { asked.push(String(url)); return asked.length === 1 ? reply(503, "box-restore-failed") : Response.json(urls); },
    wait: async (ms) => { delays.push(ms); },
  });
  assert.deepEqual(result, urls);
  assert.equal(asked.length, 2);
  assert.match(asked[0], /chat=chat-1/);
  assert.match(asked[1], /fresh=1/);
  assert.match(asked[1], /chat=chat-1/);
  assert.deepEqual(delays, [1000]);
});

test("persistent provider failures stop after two retries", async () => {
  let calls = 0;
  const delays: number[] = [];
  await assert.rejects(attachCloudSession("w", "main", false, new AbortController().signal, {
    fetch: async () => { calls++; return reply(503, "box-restore-failed"); },
    wait: async (ms) => { delays.push(ms); },
  }), /Box is waking/);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test("missing boxes, authentication, plan limits and lifecycle conflicts fail without retries", async () => {
  for (const [status, code] of [[410, "box-gone"], [401, undefined], [403, undefined], [409, undefined], [502, "session-not-started"]] as const) {
    let calls = 0;
    await assert.rejects(attachCloudSession("w", "main", false, new AbortController().signal, {
      fetch: async () => { calls++; return reply(status, code); },
      wait: async () => { assert.fail("terminal errors must not be retried"); },
    }));
    assert.equal(calls, 1);
  }
});

test("a network blip retries but a malformed successful response does not", async () => {
  let calls = 0;
  assert.deepEqual(await attachCloudSession("w", "main", false, new AbortController().signal, {
    fetch: async () => { if (++calls === 1) throw new TypeError("Failed to fetch"); return Response.json(urls); },
    wait: async () => {},
  }), urls);
  calls = 0;
  await assert.rejects(attachCloudSession("w", "main", false, new AbortController().signal, {
    fetch: async () => { calls++; return Response.json({}); },
    wait: async () => { assert.fail("malformed responses must not be retried"); },
  }), /Malformed/);
  assert.equal(calls, 1);
});

test("leaving a session cancels its retry backoff", async () => {
  const controller = new AbortController();
  let failed!: () => void;
  const requested = new Promise<void>((resolve) => { failed = resolve; });
  let calls = 0;
  const pending = attachCloudSession("w", "main", false, controller.signal, {
    fetch: async () => { calls++; failed(); return reply(503, "box-restore-failed"); },
  });
  const stopped = assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  await requested;
  controller.abort();
  await stopped;
  assert.equal(calls, 1);
});

test("a session archived or deleted elsewhere is said with its code, once, never retried", async () => {
  let calls = 0;
  await assert.rejects(
    attachCloudSession("w", "main", false, new AbortController().signal, {
      fetch: async () => { calls++; return reply(409, SESSION_ENDED); },
      wait: async () => { assert.fail("an ended session must not be retried"); },
    }),
    (error: unknown) => error instanceof AttachError && error.code === SESSION_ENDED && !error.retryable,
  );
  assert.equal(calls, 1);
});

test("what the reconnect loop may try again: a failure on the way, never one that names what happened", async () => {
  const failure = (status: number, code?: string) =>
    attachCloudSession("w", "main", false, new AbortController().signal, {
      fetch: async () => reply(status, code),
      wait: async () => {},
    }).then(() => assert.fail("attached"), (error: unknown) => error);
  assert.equal(retryableAttachFailure(await failure(503, BOX_RESTORE_FAILED)), true);
  assert.equal(retryableAttachFailure(await failure(502)), true);
  assert.equal(retryableAttachFailure(new TypeError("Failed to fetch")), true);
  // Any code the route names that isn't a failed restore ends it, a new one
  // (a session archived from another tab) as much as the known ones.
  for (const [status, code] of [[410, BOX_GONE], [502, SESSION_NOT_STARTED], [409, SESSION_ENDED], [401, undefined], [404, undefined]] as const) {
    assert.equal(retryableAttachFailure(await failure(status, code)), false, `${status} ${code}`);
  }
  assert.equal(retryableAttachFailure(new AttachError("x", null)), false);
  assert.equal(retryableAttachFailure(new Error("Malformed session response from server")), false);
});

test("a bare 500 or a Cloudflare 52x, no answer of the server's, is tried again: a deploy replacing the control plane", async () => {
  for (const status of [500, 520, 524]) {
    let calls = 0;
    const result = await attachCloudSession("w", "main", false, new AbortController().signal, {
      fetch: async () => (++calls === 1 ? new Response("upstream gone", { status }) : Response.json(urls)),
      wait: async () => {},
    });
    assert.deepEqual(result, urls);
    assert.equal(calls, 2);
  }
  // One the server answered, with what happened, is not.
  let calls = 0;
  await assert.rejects(attachCloudSession("w", "main", false, new AbortController().signal, {
    fetch: async () => { calls++; return Response.json({ error: "Runtime Computer secret missing.", code: "box-gone" }, { status: 500 }); },
    wait: async () => { assert.fail("an answered refusal must not be retried"); },
  }));
  assert.equal(calls, 1);
});
