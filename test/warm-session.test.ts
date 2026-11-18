import assert from "node:assert/strict";
import { test } from "node:test";

import { keepSessionUrls, takeWarmUrls, WARM_URLS_FOR_MS } from "@/lib/session/warm-session";

const urls = { ptyUrl: "wss://box/pty?t=1", eventsUrl: "wss://box/events-ws?t=1" };

test("a session left and opened again soon attaches with the URLs it had", async () => {
  keepSessionUrls("w1", urls, Date.now() - 5_000);
  assert.deepEqual(await takeWarmUrls("w1"), urls);
  // Taken once: the page that took them keeps them from here.
  assert.equal(await takeWarmUrls("w1"), null);
});

test("URLs too old to open a socket on aren't kept", async () => {
  keepSessionUrls("w2", urls, Date.now() - WARM_URLS_FOR_MS);
  assert.equal(await takeWarmUrls("w2"), null);
});

test("a newer warm-up isn't replaced by older URLs", async () => {
  const newer = { ...urls, eventsUrl: "wss://box/events-ws?t=2" };
  keepSessionUrls("w3", newer, Date.now() - 1_000);
  keepSessionUrls("w3", urls, Date.now() - 10_000);
  assert.deepEqual(await takeWarmUrls("w3"), newer);
});

test("a stalled sidebar warm-up cannot block opening a session", async () => {
  const { warmSession, WARM_WAIT_MS } = await import("@/lib/session/warm-session");
  const original = globalThis.fetch;
  globalThis.fetch = () => new Promise<Response>(() => {});
  try {
    warmSession("stalled-warm");
    const since = Date.now();
    assert.equal(await takeWarmUrls("stalled-warm"), null);
    assert.ok(Date.now() - since < WARM_WAIT_MS + 1000, "opening falls back instead of waiting for the stuck probe");
  } finally {
    globalThis.fetch = original;
  }
});

/** A socket the test drives: it opens, sends frames, and records its close. */
class FakeSocket extends EventTarget {
  static last: FakeSocket | null = null;
  closed = false;
  constructor() {
    super();
    FakeSocket.last = this;
  }
  close() {
    this.closed = true;
  }
  frame(id: string, data: unknown) {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ id, data }) }));
  }
}

test("a prefetch takes the history in, then closes its socket once the stream goes quiet", async () => {
  const { warmSession, WARM_QUIET_MS } = await import("@/lib/session/warm-session");
  const { CONVERSATIONS } = await import("@/lib/session/conversation-cache");
  const originalFetch = globalThis.fetch;
  const originalSocket = globalThis.WebSocket;
  globalThis.fetch = async () => Response.json(urls);
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  try {
    let done = false;
    const warm = warmSession("prefetch-1", { settle: true }).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = FakeSocket.last!;
    socket.dispatchEvent(new Event("open"));
    socket.frame("10", { t: "message", uuid: "u1", parentUuid: null, role: "assistant", timestamp: "t", content: [{ type: "text", text: "hello" }] });
    await new Promise((resolve) => setTimeout(resolve, WARM_QUIET_MS / 2));
    assert.equal(done, false, "still taking it in");
    await warm;
    assert.equal(socket.closed, true);
    assert.equal(CONVERSATIONS.get("prefetch-1")?.events.length, 1);
    // The URLs stand in for a click that follows, as a hover's do.
    assert.deepEqual(await takeWarmUrls("prefetch-1"), urls);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalSocket;
  }
});

test("a prefetch with nothing to warm is done at once", async () => {
  const { warmSession } = await import("@/lib/session/warm-session");
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: "Its session isn't running to warm." }, { status: 409 });
  try {
    await warmSession("prefetch-asleep", { settle: true });
  } finally {
    globalThis.fetch = original;
  }
});
