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
