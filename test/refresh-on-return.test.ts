import assert from "node:assert/strict";
import { test } from "node:test";

import { refreshSessionOnReturn, SESSION_RETURN_REFRESH_MS } from "@/lib/session/refresh-on-return";

function browser() {
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const window = new EventTarget();
  let now = 0;
  let validated = 0;
  let attaching = false;
  let refreshes = 0;
  const dispose = refreshSessionOnReturn({
    page,
    window,
    now: () => now,
    lastValidatedAt: () => validated,
    attaching: () => attaching,
    refresh: () => {
      refreshes++;
      attaching = true;
    },
  });
  return {
    page, window, dispose,
    advance(ms: number) { now += ms; },
    refreshed() { validated = now; attaching = false; },
    get refreshes() { return refreshes; },
  };
}

test("returning after an idle pause reattaches even if the socket never reported a close", () => {
  const b = browser();
  b.page.visibilityState = "hidden";
  b.page.dispatchEvent(new Event("visibilitychange"));
  b.advance(16 * 60_000);
  assert.equal(b.refreshes, 0, "backgrounding must not keep idle computers running");

  b.page.visibilityState = "visible";
  b.page.dispatchEvent(new Event("visibilitychange"));
  assert.equal(b.refreshes, 1);
  b.window.dispatchEvent(new Event("focus"));
  b.window.dispatchEvent(new Event("online"));
  assert.equal(b.refreshes, 1, "one return must not start simultaneous attaches");

  b.refreshed();
  b.window.dispatchEvent(new Event("focus"));
  assert.equal(b.refreshes, 1, "a fresh connection is retained");
  b.dispose();
});

test("a browser or network waking without a visibility event revalidates old URLs", () => {
  for (const event of ["focus", "online"]) {
    const b = browser();
    b.advance(SESSION_RETURN_REFRESH_MS - 1);
    b.window.dispatchEvent(new Event(event));
    assert.equal(b.refreshes, 0);
    b.advance(1);
    b.window.dispatchEvent(new Event(event));
    assert.equal(b.refreshes, 1);
    b.dispose();
  }
});

test("hidden pages do not wake boxes and disposed sessions stop observing browser events", () => {
  const b = browser();
  b.advance(SESSION_RETURN_REFRESH_MS);
  b.page.visibilityState = "hidden";
  b.window.dispatchEvent(new Event("focus"));
  b.window.dispatchEvent(new Event("online"));
  assert.equal(b.refreshes, 0);
  b.dispose();
  b.page.visibilityState = "visible";
  b.page.dispatchEvent(new Event("visibilitychange"));
  b.window.dispatchEvent(new Event("focus"));
  assert.equal(b.refreshes, 0);
});
