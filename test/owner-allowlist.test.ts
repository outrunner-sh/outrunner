import assert from "node:assert/strict";
import { test } from "node:test";

import { githubUserId, isOwner, parseAllowlist } from "@/lib/auth/allowlist";
import type { User } from "@supabase/supabase-js";

test("parseAllowlist accepts a single login", () => {
  const set = parseAllowlist("octocat");
  assert.deepEqual([...set], ["octocat"]);
});

test("parseAllowlist splits a comma-separated team and lowercases", () => {
  const set = parseAllowlist("Octocat, Alice ,BOB");
  assert.equal(set.has("octocat"), true);
  assert.equal(set.has("alice"), true);
  assert.equal(set.has("bob"), true);
  assert.equal(set.size, 3);
});

test("parseAllowlist tolerates whitespace/newline separators and blanks", () => {
  const set = parseAllowlist("  you \n teammate ,, ");
  assert.deepEqual([...set].sort(), ["teammate", "you"]);
});

test("parseAllowlist yields an empty set for blank/undefined (rejects everyone)", () => {
  assert.equal(parseAllowlist("").size, 0);
  assert.equal(parseAllowlist("   ").size, 0);
  assert.equal(parseAllowlist(undefined).size, 0);
});

/**
 * Regression: open sign-up used to resolve the GitHub login BEFORE consulting
 * the allowlist, and returned false when it could not. A deployment configured
 * to admit everyone then admitted one teammate and rejected another with
 * "Sign in as the Runtime owner", depending on whether identity_data happened
 * to carry a login. When the allowlist is empty, the login must not be
 * consulted at all.
 */
test("open sign-up admits a user whose identity carries no login", () => {
  delete process.env.RUNTIME_OWNER_GITHUB_LOGIN;
  assert.equal(isOwner({ identities: [] } as unknown as User), true);
  assert.equal(isOwner({} as unknown as User), true);
  assert.equal(
    isOwner({ identities: [{ provider: "github", identity_data: {} }] } as unknown as User),
    true,
  );
});

test("a restricted allowlist still rejects a user with no resolvable login", () => {
  process.env.RUNTIME_OWNER_GITHUB_LOGIN = "someone";
  assert.equal(isOwner({ identities: [] } as unknown as User), false);
  delete process.env.RUNTIME_OWNER_GITHUB_LOGIN;
});

test("a user an org let in passes a restricted allowlist; one who only set it on themselves doesn't", () => {
  process.env.RUNTIME_OWNER_GITHUB_LOGIN = "someone";
  const github = [{ provider: "github", identity_data: { user_name: "newcomer" } }];
  assert.equal(isOwner({ identities: github, app_metadata: { outrunner_admitted: true } } as unknown as User), true);
  assert.equal(isOwner({ identities: github, app_metadata: {} } as unknown as User), false);
  // user_metadata is the user's own to write: it lets no one in.
  assert.equal(isOwner({ identities: github, user_metadata: { outrunner_admitted: true } } as unknown as User), false);
  delete process.env.RUNTIME_OWNER_GITHUB_LOGIN;
});

test("the GitHub user's numeric id comes from the server-kept identity, never user_metadata", () => {
  const user = (identity: Record<string, unknown>, meta: Record<string, unknown> = {}) =>
    ({ identities: [{ provider: "github", id: "ignored-if-provider-id", identity_data: identity }], user_metadata: meta }) as unknown as User;
  assert.equal(githubUserId(user({ provider_id: "583231", user_name: "octocat" })), 583231);
  assert.equal(githubUserId(user({ sub: "42" })), 42);
  // Not a number: none, rather than a guess.
  assert.equal(githubUserId(user({ provider_id: "abc" }, { provider_id: "1" })), null);
  assert.equal(githubUserId({ identities: [{ provider: "email", identity_data: { sub: "7" } }] } as unknown as User), null);
});
