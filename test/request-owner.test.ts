import assert from "node:assert/strict";
import { test } from "node:test";

import type { Owner } from "@/lib/auth/owner";
import { ownerOfRequest } from "@/lib/auth/request-owner";

const owner: Owner = { id: "u1", githubLogin: "immad", name: "Immad", email: null, avatarUrl: null };
const BASE = "http://localhost:3000";

function sources(cli: Owner | null, browser: Owner | null) {
  const asked: string[] = [];
  return {
    asked,
    sources: {
      cli: async () => (asked.push("cli"), cli),
      browser: async () => (asked.push("browser"), browser),
    },
  };
}

test("a bearer token signs in the CLI, with no Origin", async () => {
  const { sources: s, asked } = sources(owner, null);
  const result = await ownerOfRequest(new Request(`${BASE}/api/imports`, { headers: { authorization: "Bearer or_cli_x" } }), s);
  assert.deepEqual(result, { owner });
  assert.deepEqual(asked, ["cli"]);
});

test("a bearer token that signs no one in is refused, never tried as a cookie", async () => {
  const { sources: s, asked } = sources(null, owner);
  const result = await ownerOfRequest(new Request(`${BASE}/api/imports`, { headers: { authorization: "Bearer nope" } }), s);
  assert.ok("response" in result && result.response.status === 401);
  assert.deepEqual(asked, ["cli"]);
});

test("the page's request still needs its Origin, then its session", async () => {
  process.env.RUNTIME_BASE_URL = BASE;
  const crossSite = await ownerOfRequest(new Request(`${BASE}/api/imports`, { headers: { origin: "https://evil.example" } }), sources(null, owner).sources);
  assert.ok("response" in crossSite && crossSite.response.status === 403);

  const page = await ownerOfRequest(new Request(`${BASE}/api/imports`, { headers: { origin: BASE } }), sources(null, owner).sources);
  assert.deepEqual(page, { owner });

  const signedOut = await ownerOfRequest(new Request(`${BASE}/api/imports`, { headers: { origin: BASE } }), sources(null, null).sources);
  assert.ok("response" in signedOut && signedOut.response.status === 401);
});
