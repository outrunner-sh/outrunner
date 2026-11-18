import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { GitHubSyncError, inspectPersonalToken } from "@/lib/github/client";
import { isPersonalConnected, pickPersonalCredential, type PersonalDeps } from "@/lib/github/personal-choice";
import {
  connectPersonalToken,
  parseTokenExpiry,
  personalTokenHealthNote,
  personalTokenNotes,
  type PersonalTokenInfo,
} from "@/lib/github/personal-token";
import { pickRepositorySource } from "@/lib/github/source-choice";
import { GitHubConnectionBrokenError } from "@/lib/github/user-connection";
import { readTokenBody } from "@/lib/http/token-body";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const NOW = new Date("2026-11-14T12:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;

function personal(over: Partial<PersonalDeps> = {}): PersonalDeps {
  return {
    pat: async () => ({ token: "github_pat_mine", login: "harsh", updatedAt: "2026-11-14T10:00:00Z" }),
    appUser: async () => ({ token: "ghu_app", expiresAt: new Date(NOW + 8 * 60 * 60 * 1000) }),
    legacy: async () => "gho_old",
    ...over,
  };
}

test("a pasted token wins over the App connection, which wins over an old sign-in token", async () => {
  const pat = await pickPersonalCredential("u1", personal());
  // Handed out with no expiry, so a box re-asks within minutes after it's removed.
  assert.deepEqual(pat, { source: "pat", token: "github_pat_mine", expiresAt: null, login: "harsh", updatedAt: "2026-11-14T10:00:00Z" });

  // One that no longer opens (a rotated key) is read as none: the next one is used.
  assert.equal((await pickPersonalCredential("u1", personal({ pat: async () => null })))?.source, "app_user");
  assert.equal((await pickPersonalCredential("u1", personal({ pat: async () => null, appUser: async () => null })))?.source, "legacy");
  assert.equal(await pickPersonalCredential("u1", personal({ pat: async () => null, appUser: async () => null, legacy: async () => null })), null);
});

test("a token keeps working while the App connection is broken; without one, broken still says reconnect", async () => {
  const broken = async () => {
    throw new GitHubConnectionBrokenError();
  };
  assert.equal((await pickPersonalCredential("u1", personal({ appUser: broken })))?.source, "pat");
  await assert.rejects(
    pickPersonalCredential("u1", personal({ pat: async () => null, appUser: broken, legacy: async () => null })),
    GitHubConnectionBrokenError,
  );
});

test("a user with only a token has connected their own GitHub, so is never quietly worked as the App", async () => {
  const no = async () => false;
  assert.equal(await isPersonalConnected("u1", { hasToken: async () => true, hasAppConnection: no, hasLegacy: no }), true);
  assert.equal(await isPersonalConnected("u1", { hasToken: no, hasAppConnection: no, hasLegacy: no }), false);
});

test("a token lists in the user's own org, over its installations, but never in a team org", () => {
  assert.equal(pickRepositorySource({ personal: true, installations: 2, own: "pat" }), "pat");
  assert.equal(pickRepositorySource({ personal: true, installations: 2, own: "app_user" }), "user_app");
  assert.equal(pickRepositorySource({ personal: true, installations: 2, own: "legacy" }), "app");
  assert.equal(pickRepositorySource({ personal: true, installations: 0, own: "legacy" }), "legacy");
  assert.equal(pickRepositorySource({ personal: true, installations: 0, own: null }), "missing");
  // A team org is the App's alone, whatever the member has.
  assert.equal(pickRepositorySource({ personal: false, installations: 1, own: "pat" }), "app");
  assert.equal(pickRepositorySource({ personal: false, installations: 0, own: "pat" }), "no_installation");
});

/** GitHub answering `/user` with this status, body and headers. */
function github(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  const asked: string[] = [];
  globalThis.fetch = (async (url: URL | string) => {
    asked.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }) as typeof fetch;
  return asked;
}

test("a classic token reports its scopes and expiry; a fine-grained one, no scopes", async () => {
  github(200, { id: 42, login: "harsh" }, { "x-oauth-scopes": "repo, workflow", "github-authentication-token-expiration": "2026-12-14 10:00:00 UTC" });
  assert.deepEqual(await inspectPersonalToken("ghp_abc123"), {
    githubUserId: 42,
    login: "harsh",
    kind: "classic",
    scopes: ["repo", "workflow"],
    expiresAt: new Date("2026-12-14T10:00:00Z"),
  });

  // A classic token with no scopes still says so (an empty header); one that never expires has no expiry header.
  github(200, { id: 42, login: "harsh" }, { "x-oauth-scopes": "" });
  assert.deepEqual(await inspectPersonalToken("ghp_abc123"), { githubUserId: 42, login: "harsh", kind: "classic", scopes: [], expiresAt: null });

  github(200, { id: 42, login: "harsh" }, { "github-authentication-token-expiration": "2027-01-01 00:00:00 +0530" });
  const fine = await inspectPersonalToken("github_pat_11ABC_def");
  assert.equal(fine.kind, "fine_grained");
  assert.equal(fine.scopes, null);
  assert.deepEqual(fine.expiresAt, new Date("2026-12-31T18:30:00Z"));
});

test("a token that isn't a personal one, or that GitHub refuses, is turned away with what to do", async () => {
  const asked = github(200, { id: 1, login: "x" });
  for (const token of ["gho_oauth", "ghs_install", "ghu_app", "glpat-gitlab", "ghp_has space"]) {
    await assert.rejects(inspectPersonalToken(token), (e: unknown) => e instanceof GitHubSyncError && e.status === 400 && /personal access token/.test(e.message));
  }
  assert.equal(asked.length, 0, "never sent to GitHub");

  github(401, { message: "Bad credentials" });
  await assert.rejects(inspectPersonalToken("ghp_revoked"), (e: unknown) => e instanceof GitHubSyncError && e.status === 400 && /didn't accept/.test(e.message));
  // A rate limit says nothing about the token: try again.
  github(403, {}, { "x-ratelimit-remaining": "0" });
  await assert.rejects(inspectPersonalToken("ghp_fine"), (e: unknown) => e instanceof GitHubSyncError && e.status === 502);
});

test("GitHub's expiry header is read with or without an offset, and nothing else", () => {
  assert.deepEqual(parseTokenExpiry("2026-12-14 10:00:00 UTC"), new Date("2026-12-14T10:00:00Z"));
  assert.deepEqual(parseTokenExpiry("2026-12-14 10:00:00 -0800"), new Date("2026-12-14T18:00:00Z"));
  assert.equal(parseTokenExpiry(null), null);
  assert.equal(parseTokenExpiry("soon"), null);
});

const info: PersonalTokenInfo = { githubUserId: 42, login: "harsh", kind: "fine_grained", scopes: null, expiresAt: null };
const view = { login: "harsh", kind: "fine_grained" as const, scopes: null, expiresAt: null, updatedAt: "2026-11-14T12:00:00Z" };

test("saving a token GitHub accepts switches the user to working as their own account", async () => {
  const calls: string[] = [];
  const saved = await connectPersonalToken("u1", "github_pat_x", {
    inspect: async () => (calls.push("inspect"), info),
    save: async () => (calls.push("save"), view),
    workAsThemselves: async () => void calls.push("identity"),
  });
  assert.deepEqual(calls, ["inspect", "save", "identity"]);
  assert.deepEqual(saved, { token: view, identitySwitched: true });

  // The identity not switching keeps the token, and says so.
  const kept = await connectPersonalToken("u1", "github_pat_x", {
    inspect: async () => info,
    save: async () => view,
    workAsThemselves: async () => {
      throw new Error("db down");
    },
  });
  assert.equal(kept.identitySwitched, false);

  // One GitHub refuses is never saved, and the identity is left alone.
  const touched: string[] = [];
  await assert.rejects(
    connectPersonalToken("u1", "ghp_bad", {
      inspect: async () => {
        throw new GitHubSyncError("GitHub didn't accept this token.", 400);
      },
      save: async () => (touched.push("save"), view),
      workAsThemselves: async () => void touched.push("identity"),
    }),
    GitHubSyncError,
  );
  assert.deepEqual(touched, []);
});

test("the card warns about a missing repo scope, an expiry near or past, and a token that never expires", () => {
  const texts = (t: Parameters<typeof personalTokenNotes>[0]) => personalTokenNotes(t, NOW).map((n) => `${n.tone}: ${n.text}`);
  const inMonth = new Date(NOW + 30 * DAY).toISOString();

  assert.deepEqual(texts({ ...view, expiresAt: inMonth }), []);
  assert.match(texts({ ...view, kind: "classic", scopes: ["read:user"], expiresAt: inMonth })[0], /^warning: .*repo scope/);
  // A fine-grained token's permissions aren't reported: no scope warning.
  assert.deepEqual(texts({ ...view, kind: "fine_grained", scopes: null, expiresAt: inMonth }), []);
  assert.match(texts({ ...view, expiresAt: new Date(NOW + 3 * DAY).toISOString() })[0], /^warning: This token expires on Nov 17, 2026/);
  assert.deepEqual(texts({ ...view, expiresAt: new Date(NOW - DAY).toISOString() }), [
    "error: @harsh's token expired on Nov 13, 2026. Replace it to keep working on GitHub.",
  ]);
  assert.match(texts({ ...view, expiresAt: null })[0], /^warning: This token never expires/);
});

test("the streamed health note says a refused token needs replacing, and stays quiet when it works or already shows expired", () => {
  const live = { login: "harsh", expiresAt: new Date(NOW + 30 * DAY).toISOString() };
  assert.equal(personalTokenHealthNote(live, "ok", NOW), null);
  assert.equal(personalTokenHealthNote(live, "refused", NOW)?.tone, "error");
  assert.equal(personalTokenHealthNote(live, "unreachable", NOW)?.tone, "info");
  assert.equal(personalTokenHealthNote({ login: "harsh", expiresAt: new Date(NOW - DAY).toISOString() }, "refused", NOW), null);
});

test("a posted token is trimmed, and an empty, malformed or multi-line one is refused", async () => {
  const post = (body: string) => new Request("https://outrunner.test/api/github/token", { method: "POST", body });
  assert.equal(await readTokenBody(post(JSON.stringify({ token: "  ghp_x  " })), "a token"), "ghp_x");
  for (const body of ["", "not json", "null", JSON.stringify({ token: "" }), JSON.stringify({ token: 7 }), JSON.stringify({ token: "ghp_x\nHost: evil" }), JSON.stringify({ token: "x".repeat(5000) })]) {
    const refused = await readTokenBody(post(body), "a GitHub personal access token");
    assert.ok(refused instanceof Response, body.slice(0, 20));
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: "Enter a GitHub personal access token." });
  }
});
