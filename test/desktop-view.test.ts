import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BROWSER_UNREACHABLE,
  DESKTOP_TIMED_OUT,
  DESKTOP_UNREACHABLE,
  type DesktopEvent,
  type DesktopView,
  desktopView,
  FIRST_VIEW,
  IN_USE_EVERY_MS,
  inUseReporter,
  openDesktop,
  openDesktopBrowser,
  RECONNECT_DELAYS_MS,
  STEADY_MS,
  VIEWER_FAILED,
} from "@/lib/session/desktop-view";

const run = (...events: DesktopEvent[]): DesktopView => events.reduce(desktopView, FIRST_VIEW);

test("the tab starts the desktop, then connects to it", () => {
  assert.deepEqual(FIRST_VIEW, { status: "starting", attempt: 0 });
  assert.deepEqual(run({ type: "opened" }), { status: "connecting", attempt: 0 });
  assert.deepEqual(run({ type: "opened" }, { type: "connect" }), { status: "connected", attempt: 0 });
});

const connected = [{ type: "opened" }, { type: "connect" }] as const;
/** A reconnect that connects, then drops again at once. */
const quickDrop = (clean = false): DesktopEvent[] => [
  { type: "retry" },
  { type: "opened" },
  { type: "connect" },
  { type: "disconnect", clean, lasted: 1_000 },
];

test("a live socket that drops reconnects on its own, with a fresh link, and is live again", () => {
  // Dropped after a few minutes connected, as the customer's did.
  const dropped = run(...connected, { type: "disconnect", clean: false, lasted: 3 * 60_000 });
  assert.deepEqual(dropped, { status: "reconnecting", attempt: 0, tries: 1, retryInMs: RECONNECT_DELAYS_MS[0] });
  // The wait over, a new attempt asks for a fresh link, as Reconnect would.
  const retried = desktopView(dropped, { type: "retry" });
  assert.deepEqual(retried, { status: "starting", attempt: 1, tries: 1 });
  assert.deepEqual(run(...connected, { type: "disconnect", clean: true, lasted: 3 * 60_000 }, { type: "retry" }, ...connected), {
    status: "connected",
    attempt: 1,
    tries: 1,
  });
});

test("a connection that lasts starts the tries afresh, so drops every few minutes are reconnected for good", () => {
  const events: DesktopEvent[] = [...connected];
  for (let i = 0; i < 10; i++) events.push({ type: "disconnect", clean: false, lasted: STEADY_MS }, { type: "retry" }, ...connected);
  const view = run(...events);
  assert.equal(view.status, "connected");
  assert.equal(view.attempt, 10);
});

test("a socket that keeps dropping as soon as it connects ends on Reconnect, saying how it closed", () => {
  // Each reconnect connects and drops at once: the tries run out.
  const flapping = (clean: boolean) =>
    run(...connected, { type: "disconnect", clean, lasted: 1_000 }, ...quickDrop(clean), ...quickDrop(clean), ...quickDrop(clean));
  assert.deepEqual(flapping(true), { status: "disconnected", attempt: 3, reason: "The desktop closed the connection." });
  assert.equal((flapping(false) as { reason: string }).reason, "The connection to the desktop was lost.");
  // One short of the last try is still being retried, after the longest wait.
  const nearly = run(...connected, { type: "disconnect", clean: false, lasted: 1_000 }, ...quickDrop(), ...quickDrop());
  assert.deepEqual(nearly, { status: "reconnecting", attempt: 2, tries: 3, retryInMs: RECONNECT_DELAYS_MS[2] });
});

test("reconnects that can't connect, or can't reach Outrunner, are tried again, then given up", () => {
  const dropped = [...connected, { type: "disconnect", clean: false, lasted: 5 * 60_000 }] as DesktopEvent[];
  // Never opened, then a socket that never finishes, then Outrunner out of reach.
  const view = run(
    ...dropped,
    { type: "retry" }, { type: "opened" }, { type: "disconnect", clean: false },
    { type: "retry" }, { type: "opened" }, { type: "stalled" },
    { type: "retry" }, { type: "refused", httpStatus: 0 },
  );
  assert.deepEqual(view, { status: "error", attempt: 3, message: DESKTOP_UNREACHABLE, httpStatus: 0 });
  // Mid-way, each is another try, not the end.
  assert.equal(run(...dropped, { type: "retry" }, { type: "refused", httpStatus: 502 }).status, "reconnecting");
  assert.equal(run(...dropped, { type: "retry" }, { type: "opened" }, { type: "stalled" }).status, "reconnecting");
});

test("a refusal mid-reconnect, or a desktop that refuses the connection, is said at once", () => {
  const dropped = [...connected, { type: "disconnect", clean: false, lasted: 5 * 60_000 }] as DesktopEvent[];
  // The box stopped: no use trying again.
  assert.deepEqual(run(...dropped, { type: "retry" }, { type: "refused", httpStatus: 409, error: "Its box isn't running." }), {
    status: "error",
    attempt: 1,
    message: "Its box isn't running.",
    httpStatus: 409,
  });
  const refused = run(...dropped, { type: "retry" }, { type: "opened" }, { type: "securityfailure", reason: "Authentication failed" }, {
    type: "disconnect",
    clean: false,
  });
  assert.equal(refused.status, "disconnected");
});

test("a first connection that fails says so rather than retrying, and Reconnect ends the tries", () => {
  // Never opened: the proxy wasn't there, or the link had lapsed.
  assert.deepEqual(run({ type: "opened" }, { type: "disconnect", clean: false }), {
    status: "disconnected",
    attempt: 0,
    reason: "Couldn't connect to the desktop.",
  });
  const reconnecting = run(...connected, { type: "disconnect", clean: false, lasted: 1_000 });
  assert.deepEqual(desktopView(reconnecting, { type: "reconnect" }), { status: "starting", attempt: 1 });
  // A drop seen late, or a retry with none due, changes nothing.
  assert.deepEqual(desktopView(reconnecting, { type: "disconnect", clean: true }), reconnecting);
  assert.deepEqual(desktopView(run(...connected), { type: "retry" }), run(...connected));
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

test("the user's moves on the desktop are told at most every few seconds, and a failure is let go", async () => {
  const sent: { url: string; method?: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method });
    if (sent.length === 2) throw new Error("offline");
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  let now = 1_000;
  const report = inUseReporter("ws-1", fetchImpl, () => now);

  report();
  report();
  now += IN_USE_EVERY_MS - 1;
  report();
  assert.deepEqual(sent, [{ url: "/api/workspaces/ws-1/desktop/activity", method: "POST" }]);

  now += 1;
  report();
  now += IN_USE_EVERY_MS;
  report();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 3);
});

test("the Browser button asks the session's desktop route, and says why when it can't", async () => {
  const asked: string[] = [];
  const answer = (res: Response | Error) =>
    (async (url: string, init?: RequestInit) => {
      asked.push(`${init?.method} ${url}`);
      if (res instanceof Error) throw res;
      return res;
    }) as unknown as typeof fetch;

  assert.equal(await openDesktopBrowser("ws-1", answer(new Response(null, { status: 204 }))), null);
  assert.deepEqual(asked, ["POST /api/workspaces/ws-1/desktop/browser"]);
  assert.equal(
    await openDesktopBrowser("ws-1", answer(Response.json({ error: "Couldn't open the browser. Please try again." }, { status: 502 }))),
    "Couldn't open the browser. Please try again.",
  );
  assert.equal(await openDesktopBrowser("ws-1", answer(new Response("Bad gateway", { status: 502 }))), BROWSER_UNREACHABLE);
  assert.equal(await openDesktopBrowser("ws-1", answer(new TypeError("Failed to fetch"))), BROWSER_UNREACHABLE);
});
