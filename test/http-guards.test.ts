/** What counts as the app's own read (lib/http/guards.ts). */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isSameOriginRead } from "@/lib/http/guards";

test("a read is the app's own unless it says it comes from elsewhere", () => {
  process.env.RUNTIME_BASE_URL = "https://app.example";
  const read = (headers: Record<string, string>) => isSameOriginRead(new Request("https://app.example/api/x", { headers }));
  assert.equal(read({}), true, "a same-origin GET carries no Origin");
  assert.equal(read({ "sec-fetch-site": "same-origin" }), true);
  assert.equal(read({ origin: "https://app.example", "sec-fetch-site": "same-origin" }), true);
  assert.equal(read({ origin: "https://evil.example" }), false);
  assert.equal(read({ "sec-fetch-site": "cross-site" }), false);
  assert.equal(read({ "sec-fetch-site": "same-site" }), false);
  assert.equal(read({ "sec-fetch-site": "none" }), false, "opened from the address bar: not the app's fetch");
});
