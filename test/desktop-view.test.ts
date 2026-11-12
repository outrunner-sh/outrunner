import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DESKTOP_TIMED_OUT,
  DESKTOP_UNREACHABLE,
  type DesktopEvent,
  type DesktopView,
  desktopView,
  FIRST_VIEW,
  openDesktop,
  VIEWER_FAILED,
} from "@/lib/session/desktop-view";

const run = (...events: DesktopEvent[]): DesktopView => events.reduce(desktopView, FIRST_VIEW);

test("the tab starts the desktop, then connects to it", () => {
  assert.deepEqual(FIRST_VIEW, { status: "starting", attempt: 0 });
  assert.deepEqual(run({ type: "opened" }), { status: "connecting", attempt: 0 });
  assert.deepEqual(run({ type: "opened" }, { type: "connect" }), { status: "connected", attempt: 0 });
});

test("a socket that closes says how", () => {
  const connected = [{ type: "opened" }, { type: "connect" }] as const;
  assert.deepEqual(run(...connected, { type: "disconnect", clean: true }), {
    status: "disconnected",
    attempt: 0,
    reason: "The desktop closed the connection.",
  });
  assert.equal(
    (run(...connected, { type: "disconnect", clean: false }) as { reason: string }).reason,
    "The connection to the desktop was lost.",
  );
  // Never opened: the proxy wasn't there, or the link had lapsed.
  assert.equal(
    (run({ type: "opened" }, { type: "disconnect", clean: false }) as { reason: string }).reason,
    "Couldn't connect to the desktop.",
  );
});

test("a refused connection keeps its reason through the disconnect that follows it", () => {
  const view = run(
    { type: "opened" },
    { type: "securityfailure", reason: "Authentication failed" },
    { type: "disconnect", clean: false },
  );
  assert.deepEqual(view, {
    status: "disconnected",
    attempt: 0,
    reason: "The desktop refused the connection: Authentication failed.",
  });
  assert.equal((run({ type: "securityfailure" }) as { reason: string }).reason, "The desktop refused the connection.");
});

test("Outrunner's refusal shows in its own words", () => {
  assert.deepEqual(run({ type: "refused", httpStatus: 409, error: "The desktop runs on Outrunner's Daytona sandboxes only." }), {
    status: "error",
    attempt: 0,
    message: "The desktop runs on Outrunner's Daytona sandboxes only.",
    httpStatus: 409,
  });
  assert.equal((run({ type: "refused", httpStatus: 0 }) as { message: string }).message, DESKTOP_UNREACHABLE);
  assert.equal(
    (run({ type: "refused", httpStatus: 502 }) as { message: string }).message,
    "Couldn't start the desktop. Please try again.",
  );
});

test("Reconnect starts a new attempt, from any state", () => {
  const lost = run({ type: "opened" }, { type: "connect" }, { type: "disconnect", clean: false });
  assert.deepEqual(desktopView(lost, { type: "reconnect" }), { status: "starting", attempt: 1 });
  const refused = run({ type: "refused", httpStatus: 502 }, { type: "reconnect" }, { type: "reconnect" });
  assert.deepEqual(refused, { status: "starting", attempt: 2 });
});

test("events out of turn leave the view as it is", () => {
  // A connect before a link, or a second link, changes nothing.
  assert.deepEqual(run({ type: "connect" }), FIRST_VIEW);
  const connected = run({ type: "opened" }, { type: "connect" });
  assert.deepEqual(desktopView(connected, { type: "opened" }), connected);
  // An error's disconnect doesn't hide what Outrunner said.
  const refused = run({ type: "refused", httpStatus: 409, error: "No desktop." });
  assert.deepEqual(desktopView(refused, { type: "disconnect", clean: true }), refused);
});

const answer = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("openDesktop asks the session's desktop route for a link", async () => {
  let asked: { url: string; method?: string } | null = null;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    asked = { url, method: init?.method };
    return new Response(JSON.stringify({ url: "wss://6080-abc.example/websockify" }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await openDesktop("ws-1", fetchImpl), { url: "wss://6080-abc.example/websockify" });
  // With the desktop's VNC password, where it has one.
  assert.deepEqual(await openDesktop("ws-1", answer(200, { url: "wss://x/websockify", password: "Ab3dEf7h" })), {
    url: "wss://x/websockify",
    password: "Ab3dEf7h",
  });
  assert.deepEqual(asked, { url: "/api/workspaces/ws-1/desktop", method: "POST" });
});

test("openDesktop hands back the route's refusal, or that it couldn't reach it", async () => {
  assert.deepEqual(await openDesktop("ws-1", answer(409, { error: "No desktop here." })), {
    type: "refused",
    httpStatus: 409,
    error: "No desktop here.",
  });
  assert.deepEqual(await openDesktop("ws-1", answer(502, "not json")), { type: "refused", httpStatus: 502 });
  // An answer without a link is no link.
  assert.deepEqual(await openDesktop("ws-1", answer(200, {})), { type: "refused", httpStatus: 200 });
  const offline = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  assert.deepEqual(await openDesktop("ws-1", offline), { type: "refused", httpStatus: 0 });
});

test("a request that hangs is given up, as a refusal that says so", async () => {
  // A test timeout signal aborts predictably; AbortSignal.timeout uses an
  // unreferenced timer, which lets Node's test runner exit before it fires.
  const timeoutSignal = (milliseconds: number) => {
    assert.equal(milliseconds, 20);
    const controller = new AbortController();
    queueMicrotask(() => controller.abort(new DOMException("timed out", "TimeoutError")));
    return controller.signal;
  };
  const hung = ((_: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as unknown as typeof fetch;
  assert.deepEqual(await openDesktop("ws-1", hung, 20, timeoutSignal), {
    type: "refused",
    httpStatus: 0,
    error: DESKTOP_TIMED_OUT,
  });
  assert.deepEqual(run({ type: "refused", httpStatus: 0, error: DESKTOP_TIMED_OUT }), {
    status: "error",
    attempt: 0,
    message: DESKTOP_TIMED_OUT,
    httpStatus: 0,
  });
});

test("a socket that never finishes connecting offers Reconnect, whatever closes after", () => {
  const stalled = run({ type: "opened" }, { type: "stalled" }, { type: "disconnect", clean: false });
  assert.deepEqual(stalled, { status: "disconnected", attempt: 0, reason: "The desktop didn't answer. Try reconnecting." });
  // Too late once connected: the view stays live.
  assert.equal(run({ type: "opened" }, { type: "connect" }, { type: "stalled" }).status, "connected");
});

test("a viewer that didn't load asks for the page to be reloaded, not tried again", () => {
  assert.deepEqual(run({ type: "opened" }, { type: "viewerfailed" }), {
    status: "error",
    attempt: 0,
    message: VIEWER_FAILED,
    httpStatus: 0,
    reload: true,
  });
});
