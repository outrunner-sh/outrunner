import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  bearerToken,
  cliCallbackUrl,
  deviceName,
  exchangeCliLoginCode,
  hashSecret,
  newCliToken,
  parseCliLoginRequest,
  randomSecret,
  verifierMatches,
} from "@/lib/auth/cli-login";

const verifier = randomSecret();
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = "s".repeat(22);

test("a complete request is read, with the computer's name", () => {
  assert.deepEqual(parseCliLoginRequest({ port: "51234", state, challenge, name: "Immad's MacBook" }), {
    port: 51234,
    state,
    challenge,
    deviceName: "Immad's MacBook",
  });
});

test("a request missing a part, or with one malformed, is refused", () => {
  const good = { port: "51234", state, challenge };
  assert.equal(parseCliLoginRequest({ ...good, port: undefined }), null);
  assert.equal(parseCliLoginRequest({ ...good, state: "short" }), null);
  assert.equal(parseCliLoginRequest({ ...good, challenge: "x" }), null);
  assert.equal(parseCliLoginRequest({ ...good, port: ["51234", "51235"] }), null);
});

test("only a plain port above the privileged range is taken: the host is never the query's", () => {
  const good = { state, challenge };
  for (const port of ["80", "1023", "65536", "51234@evil.com", "51234/../x", "-1", "0x50"]) {
    assert.equal(parseCliLoginRequest({ ...good, port }), null, port);
  }
  assert.equal(new URL(cliCallbackUrl({ port: 51234, state }, "code")).host, "127.0.0.1:51234");
});

test("the callback carries the code and the CLI's state back", () => {
  const url = new URL(cliCallbackUrl({ port: 51234, state }, "the-code"));
  assert.equal(url.pathname, "/callback");
  assert.equal(url.searchParams.get("code"), "the-code");
  assert.equal(url.searchParams.get("state"), state);
});

test("a computer's name is cut to something printable, or named for it", () => {
  assert.equal(deviceName(null), "Terminal");
  assert.equal(deviceName("  "), "Terminal");
  assert.equal(deviceName("<script>alert(1)</script>"), "scriptalert1script");
  assert.equal(deviceName("a".repeat(100)).length, 64);
});

test("the verifier must be the one the challenge was made from", () => {
  assert.equal(verifierMatches(verifier, challenge), true);
  assert.equal(verifierMatches(randomSecret(), challenge), false);
  assert.equal(verifierMatches("short", challenge), false);
});

test("a bearer header gives its token only when it is a CLI token", () => {
  const token = newCliToken();
  assert.equal(bearerToken(new Headers({ authorization: `Bearer ${token}` })), token);
  assert.equal(bearerToken(new Headers({ authorization: "Bearer something-else" })), null);
  assert.equal(bearerToken(new Headers()), null);
});

function store(expiresInMs = 60_000) {
  const code = randomSecret();
  const codes = new Map([[hashSecret(code), { userId: "u1", challenge, deviceName: "Mac", expiresAt: new Date(Date.now() + expiresInMs).toISOString() }]]);
  const tokens: { userId: string; tokenHash: string }[] = [];
  return {
    code,
    tokens,
    deps: {
      takeCode: async (hash: string) => {
        const found = codes.get(hash) ?? null;
        codes.delete(hash);
        return found;
      },
      saveToken: async (userId: string, tokenHash: string) => void tokens.push({ userId, tokenHash }),
    },
  };
}

test("a code and its verifier trade for a token, stored only as its hash", async () => {
  const { code, tokens, deps } = store();
  const result = await exchangeCliLoginCode({ code, verifier }, deps);
  assert.ok(result.ok);
  assert.match(result.token, /^or_cli_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(tokens, [{ userId: "u1", tokenHash: hashSecret(result.token) }]);
});

test("a code trades once, and a wrong verifier spends it", async () => {
  const once = store();
  assert.ok((await exchangeCliLoginCode({ code: once.code, verifier }, once.deps)).ok);
  assert.equal((await exchangeCliLoginCode({ code: once.code, verifier }, once.deps)).ok, false);

  const wrong = store();
  assert.equal((await exchangeCliLoginCode({ code: wrong.code, verifier: randomSecret() }, wrong.deps)).ok, false);
  assert.equal((await exchangeCliLoginCode({ code: wrong.code, verifier }, wrong.deps)).ok, false);
  assert.deepEqual(wrong.tokens, []);
});

test("an expired code, or one that isn't a code, gives no token", async () => {
  const expired = store(-1);
  assert.equal((await exchangeCliLoginCode({ code: expired.code, verifier }, expired.deps)).ok, false);
  const { deps, tokens } = store();
  assert.equal((await exchangeCliLoginCode({ code: 42, verifier }, deps)).ok, false);
  assert.deepEqual(tokens, []);
});
