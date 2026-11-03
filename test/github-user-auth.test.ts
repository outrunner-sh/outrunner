import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import type { GitHubAppConfig } from "@/lib/github/app";
import { legacyModeFrom, signInScopesFor } from "@/lib/github/legacy-mode";
import {
  codeChallenge,
  exchangeUserCode,
  listUserInstallations,
  needsRenewal,
  newConnectSecrets,
  nonceMatches,
  ownInstallation,
  readConnectCookie,
  readConnectState,
  refreshUserTokens,
  revokeGrant,
  signConnectState,
  UserAuthError,
  userAuthorizeUrl,
} from "@/lib/github/user-auth";

const config = { clientId: "Iv1.app", slug: "outrunner", privateKey: "", webhookSecret: "s3cret" } as GitHubAppConfig;
const state = { userId: "u1", nonce: "n1", desktop: false, next: "/settings/connections" as const };

test("a connect link's state comes back as it was sent, until it expires", () => {
  const signed = signConnectState("s3cret", { ...state, desktop: true, next: "/onboarding" }, 1_000);
  assert.deepEqual(readConnectState("s3cret", signed, 1_000), { ...state, desktop: true, next: "/onboarding" });
  // Fifteen minutes on, it's gone.
  assert.equal(readConnectState("s3cret", signed, 1_000 + 15 * 60 + 1), null);
});

test("a connect state that's changed, another secret's, or an install link's is refused", () => {
  const signed = signConnectState("s3cret", state, 1_000);
  const [payload, mac] = signed.split(".");
  const forged = Buffer.from(JSON.stringify({ u: "someone-else", n: "n1", d: 0, x: "/settings/connections", e: 9_999 })).toString("base64url");
  assert.equal(readConnectState("s3cret", `${forged}.${mac}`, 1_000), null);
  assert.equal(readConnectState("other", signed, 1_000), null);
  assert.equal(readConnectState("s3cret", `${payload}.${mac}.extra`, 1_000), null);
  assert.equal(readConnectState("s3cret", null, 1_000), null);
});

test("a connect state naming anywhere else comes back to Connections", () => {
  const payload = Buffer.from(JSON.stringify({ u: "u1", n: "n1", d: 0, x: "https://evil.example", e: 9_999 })).toString("base64url");
  // Signed by us, but with a return we never send.
  const mac = createHmac("sha256", "s3cret").update(`connect-state:${payload}`).digest("base64url");
  assert.equal(readConnectState("s3cret", `${payload}.${mac}`, 1_000)?.next, "/settings/connections");
});

test("only the browser that started connecting has its nonce", () => {
  const { nonce, verifier, cookie } = newConnectSecrets();
  assert.deepEqual(readConnectCookie(cookie), { nonce, verifier });
  assert.equal(nonceMatches({ ...state, nonce }, readConnectCookie(cookie)), true);
  assert.equal(nonceMatches({ ...state, nonce }, { nonce: "other" }), false);
  assert.equal(nonceMatches({ ...state, nonce }, null), false);
  assert.equal(readConnectCookie(undefined), null);
  assert.equal(readConnectCookie("only-one-part"), null);
});

test("the PKCE challenge is S256 of the verifier (RFC 7636's example)", () => {
  assert.equal(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("the authorize link names the App, where to come back, the state and the challenge", () => {
  const url = new URL(
    userAuthorizeUrl({ clientId: "Iv1.app", redirectUri: "http://127.0.0.1:47823", state: "st", verifier: "v", selectAccount: true }),
  );
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "Iv1.app");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:47823");
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.get("code_challenge"), codeChallenge("v"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("prompt"), "select_account");
  // No scopes: a GitHub App's permissions are its own.
  assert.equal(url.searchParams.get("scope"), null);
});

function tokenEndpoint(answer: unknown, status = 200) {
  const sent: Array<Record<string, string>> = [];
  const doFetch = (async (_input: string | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, string>);
    return Response.json(answer, { status });
  }) as typeof fetch;
  return { sent, doFetch };
}

test("a code is traded, with the verifier, for tokens that expire", async () => {
  const { sent, doFetch } = tokenEndpoint({
    access_token: "ghu_a",
    expires_in: 28_800,
    refresh_token: "ghr_r",
    refresh_token_expires_in: 15_897_600,
  });
  const tokens = await exchangeUserCode(config, "secret", { code: "c", redirectUri: "https://app/cb", verifier: "v" }, doFetch, 0);
  assert.deepEqual(tokens, {
    accessToken: "ghu_a",
    accessExpiresAt: new Date(28_800_000),
    refreshToken: "ghr_r",
    refreshExpiresAt: new Date(15_897_600_000),
  });
  assert.deepEqual(sent[0], { client_id: "Iv1.app", client_secret: "secret", code: "c", redirect_uri: "https://app/cb", code_verifier: "v" });
});

test("a code GitHub won't take is null; GitHub failing otherwise throws", async () => {
  assert.equal(
    await exchangeUserCode(config, "s", { code: "c", redirectUri: "r", verifier: "v" }, tokenEndpoint({ error: "bad_verification_code" }).doFetch),
    null,
  );
  await assert.rejects(
    exchangeUserCode(config, "s", { code: "c", redirectUri: "r", verifier: "v" }, tokenEndpoint({ error: "incorrect_client_credentials" }).doFetch),
    UserAuthError,
  );
  await assert.rejects(
    exchangeUserCode(config, "s", { code: "c", redirectUri: "r", verifier: "v" }, tokenEndpoint({}, 502).doFetch),
    UserAuthError,
  );
});

test("an App whose tokens don't expire gives no expiry and no refresh token", async () => {
  const tokens = await exchangeUserCode(
    config,
    "s",
    { code: "c", redirectUri: "r", verifier: "v" },
    tokenEndpoint({ access_token: "ghu_forever" }).doFetch,
  );
  assert.deepEqual(tokens, { accessToken: "ghu_forever", accessExpiresAt: null, refreshToken: null, refreshExpiresAt: null });
});

test("a refresh token GitHub refuses is revoked; an outage is thrown, saying nothing of the token", async () => {
  const { sent, doFetch } = tokenEndpoint({ error: "bad_refresh_token" });
  assert.equal(await refreshUserTokens(config, "s", "ghr_old", doFetch), "revoked");
  assert.deepEqual(sent[0], { client_id: "Iv1.app", client_secret: "s", grant_type: "refresh_token", refresh_token: "ghr_old" });
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(refreshUserTokens(config, "s", "ghr_old", down), UserAuthError);
});

test("the user's own installation is the one on their account, by id", async () => {
  const doFetch = (async () =>
    Response.json({
      installations: [
        { id: 1, account: { login: "zerotrail", type: "Organization", id: 10 }, repository_selection: "all", suspended_at: null },
        { id: 2, account: { login: "md", type: "User", id: 42 }, repository_selection: "selected", suspended_at: null },
        { id: 3, account: null, repository_selection: "all", suspended_at: null },
      ],
    })) as unknown as typeof fetch;
  const installations = await listUserInstallations("ghu", doFetch);
  assert.deepEqual(
    installations.map((i) => [i.id, i.accountLogin, i.repositorySelection]),
    [
      [1, "zerotrail", "all"],
      [2, "md", "selected"],
    ],
  );
  assert.equal(ownInstallation(installations, 42)?.id, 2);
  // A renamed login is still theirs by id; someone else's account isn't.
  assert.equal(ownInstallation(installations, 7), null);
});

test("a grant is revoked with the client's credentials; one gone already counts", async () => {
  const calls: Array<{ url: string; auth: string | null; method?: string }> = [];
  const answering = (status: number) =>
    (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), method: init?.method });
      return new Response(null, { status });
    }) as typeof fetch;
  assert.equal(await revokeGrant({ clientId: "Iv1.app", clientSecret: "s" }, "ghu", answering(204)), true);
  assert.equal(calls[0]?.url, "https://api.github.com/applications/Iv1.app/grant");
  assert.equal(calls[0]?.method, "DELETE");
  assert.equal(calls[0]?.auth, `Basic ${Buffer.from("Iv1.app:s").toString("base64")}`);
  assert.equal(await revokeGrant({ clientId: "Iv1.app", clientSecret: "s" }, "ghu", answering(404)), true);
  assert.equal(await revokeGrant({ clientId: "Iv1.app", clientSecret: "s" }, "ghu", answering(500)), false);
});

test("a token is renewed once it has less than ten minutes left; one that doesn't expire never is", () => {
  const now = 1_000_000;
  assert.equal(needsRenewal(new Date(now + 11 * 60_000), now), false);
  assert.equal(needsRenewal(new Date(now + 9 * 60_000), now), true);
  assert.equal(needsRenewal(new Date(now - 1), now), true);
  assert.equal(needsRenewal(null, now), false);
});

test("the old sign-in tokens' mode: as set, else kept working only where users can connect instead", () => {
  assert.equal(legacyModeFrom(undefined, true), "fallback");
  assert.equal(legacyModeFrom(undefined, false), "store");
  assert.equal(legacyModeFrom(" OFF ", true), "off");
  assert.equal(legacyModeFrom("store", true), "store");
  assert.equal(legacyModeFrom("nonsense", true), "fallback");
});

test("signing in with GitHub asks for identity alone, but for the old way", () => {
  assert.equal(signInScopesFor("fallback"), "read:user user:email");
  assert.equal(signInScopesFor("off"), "read:user user:email");
  assert.equal(signInScopesFor("store"), "read:user user:email repo");
});
