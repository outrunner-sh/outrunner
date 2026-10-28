import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { tokenOwner } from "@/lib/github/client";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** GitHub answering `/user` with this status, body and headers. */
function github(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })) as typeof fetch;
}

test("a token GitHub takes is its user's, by id", async () => {
  github(200, { id: 583231, login: "octocat" });
  assert.deepEqual(await tokenOwner("gho_x"), { kind: "user", id: 583231 });
});

test("GitHub's own no is a refusal: not a GitHub token, or a revoked one", async () => {
  github(401, { message: "Bad credentials" });
  assert.deepEqual(await tokenOwner("ya29.google"), { kind: "refused" });
  github(403, { message: "Forbidden" });
  assert.deepEqual(await tokenOwner("gho_x"), { kind: "refused" });
});

test("no answer says nothing about the token: down, rate limited, unreadable, unreachable", async () => {
  github(503);
  assert.deepEqual(await tokenOwner("gho_x"), { kind: "unreachable" });
  github(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" });
  assert.deepEqual(await tokenOwner("gho_x"), { kind: "unreachable" });
  github(429, {}, { "retry-after": "60" });
  assert.deepEqual(await tokenOwner("gho_x"), { kind: "unreachable" });
  github(200, { login: "no-id" });
  assert.deepEqual(await tokenOwner("gho_x"), { kind: "unreachable" });
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  assert.deepEqual(await tokenOwner("gho_x"), { kind: "unreachable" });
});
