import assert from "node:assert/strict";
import { test } from "node:test";

import { drained, holdOpen, pendingWork } from "@/lib/observability/drain";
import { sentryOptions } from "@/lib/observability/report";
import { clientSentryOptions } from "@/lib/observability/sentry-options";
import { timeoutSignal, TimeoutError, withTimeout } from "@/lib/http/timeout";

test("drained waits for the work under way, and gives up after its limit", async () => {
  assert.equal(await drained(10), true);
  const first = holdOpen();
  const second = holdOpen();
  assert.equal(pendingWork(), 2);
  assert.equal(await drained(20), false);
  const waiting = drained(1_000);
  first();
  first(); // twice is once
  assert.equal(pendingWork(), 1);
  second();
  assert.equal(await waiting, true);
  assert.equal(pendingWork(), 0);
});

test("the count is one for every copy of the module (server.ts's and Next's)", async () => {
  const copy = (await import(`../lib/observability/drain.ts?copy=${Date.now()}`)) as typeof import("@/lib/observability/drain");
  const release = copy.holdOpen();
  assert.equal(pendingWork(), 1);
  release();
  assert.equal(pendingWork(), 0);
});

test("Sentry is off without SENTRY_DSN, and sends no request data with it", () => {
  assert.equal(sentryOptions({ NODE_ENV: "production" }), null);
  assert.equal(sentryOptions({ SENTRY_DSN: "  " }), null);
  const options = sentryOptions({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/2", NODE_ENV: "production", OUTRUNNER_BUILD: "abc123" });
  assert.equal(options?.release, "abc123");
  assert.equal(options?.environment, "production");
  assert.equal(options?.tracesSampleRate, 0);
  const collect = (options as { dataCollection?: Record<string, unknown> }).dataCollection;
  assert.equal(collect?.httpHeaders, false);
  assert.equal(collect?.cookies, false);
  assert.deepEqual(collect?.httpBodies, []);
  assert.equal(collect?.urlQueryParams, false);
  // The browser's DSN serves the server when it has none of its own.
  assert.equal(sentryOptions({ NEXT_PUBLIC_SENTRY_DSN: "https://b@o1.ingest.sentry.io/3" })?.dsn, "https://b@o1.ingest.sentry.io/3");
  assert.equal(sentryOptions({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/2", NEXT_PUBLIC_SENTRY_DSN: "https://b@o1.ingest.sentry.io/3" })?.dsn, "https://k@o1.ingest.sentry.io/2");
});

test("the browser's Sentry is off without a built-in DSN, keeps the server's privacy, and drops console breadcrumbs", () => {
  assert.equal(clientSentryOptions({ dsn: undefined, nodeEnv: "production" }), null);
  assert.equal(clientSentryOptions({ dsn: " ", nodeEnv: "production" }), null);
  const client = clientSentryOptions({ dsn: "https://b@o1.ingest.sentry.io/3", nodeEnv: "production" });
  const server = sentryOptions({ SENTRY_DSN: "https://b@o1.ingest.sentry.io/3", NODE_ENV: "production" });
  assert.deepEqual(client?.dataCollection, (server as { dataCollection?: unknown }).dataCollection);
  assert.equal(client?.environment, "production");
  assert.equal(client?.tracesSampleRate, 0);
  assert.equal(client?.release, undefined);
  assert.equal(clientSentryOptions({ dsn: "https://b@o1.ingest.sentry.io/3", environment: "staging", nodeEnv: "production" })?.environment, "staging");
  assert.equal(client?.beforeBreadcrumb({ category: "console", message: "the user's prompt" }), null);
  const click = { category: "ui.click", message: "button.send" };
  assert.equal(client?.beforeBreadcrumb(click), click);
  assert.deepEqual(client?.beforeBreadcrumb({}), {});
});

test("the browser keeps frames' real URLs, so Sentry can fetch the served source maps", () => {
  // Named as @sentry/nextjs 11 names its browser defaults.
  const defaults = ["GlobalHandlers", "Dedupe", "BrowserTracing", "NextjsClientStackFrameNormalization"].map((name) => ({ name }));
  const client = clientSentryOptions({ dsn: "https://b@o1.ingest.sentry.io/3", nodeEnv: "production" });
  assert.deepEqual(client?.integrations(defaults).map((integration) => integration.name), ["GlobalHandlers", "Dedupe"]);
});

test("withTimeout gives up on slow work, and timeoutSignal keeps the caller's own signal", async () => {
  assert.equal(await withTimeout(Promise.resolve(1), 50, "fast"), 1);
  await assert.rejects(withTimeout(new Promise(() => {}), 10, "Slow work"), (error: unknown) => error instanceof TimeoutError && /Slow work/.test((error as Error).message));
  const caller = new AbortController();
  const signal = timeoutSignal(60_000, caller.signal);
  assert.equal(signal.aborted, false);
  caller.abort();
  assert.equal(signal.aborted, true);
});
