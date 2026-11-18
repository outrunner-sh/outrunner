import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { openPendingTab } from "@/lib/client/pending-tab";

type Fake = { opened: string[]; assigned: string[] };

/** A window as the Mac app's webview is one: a page on app.outrunner.sh
 *  whose `window.open` gives a window only for the app's own pages. */
function macApp(): Fake {
  const fake: Fake = { opened: [], assigned: [] };
  const href = "https://app.outrunner.sh/workspaces/w1";
  (globalThis as { window?: unknown }).window = {
    __RUNTIME_DESKTOP__: true,
    location: { href, origin: new URL(href).origin, assign: (url: string) => fake.assigned.push(url) },
    open: (url: string) => {
      fake.opened.push(url);
      return url.startsWith("/") ? {} : null;
    },
  };
  return fake;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

test("in the Mac app no blank tab opens ahead, and another site's link goes to the browser", () => {
  const fake = macApp();
  const tab = openPendingTab("Opening port 3100…");
  assert.deepEqual(fake.opened, []);
  assert.equal(tab.closed(), false);
  assert.equal(tab.go("https://3100-abc.proxy.daytona.works/"), true);
  assert.deepEqual(fake.assigned, ["https://3100-abc.proxy.daytona.works/"]);
  assert.deepEqual(fake.opened, []);
});

test("in the Mac app the app's own page opens as a window", () => {
  const fake = macApp();
  assert.equal(openPendingTab("Opening…").go("/api/workspaces/w1/canvas/file?path=a.html"), true);
  assert.deepEqual(fake.opened, ["/api/workspaces/w1/canvas/file?path=a.html"]);
  assert.deepEqual(fake.assigned, []);
});
