import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, test } from "node:test";
import type { User } from "@supabase/supabase-js";

import { desktopContext, desktopDestination, readDesktopContext, readDesktopGrant, sealDesktopContext, sealDesktopGrant } from "@/lib/auth/desktop/grant";
import { createDesktopTicket, redeemDesktopTicket } from "@/lib/auth/desktop/session";

const originalKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
const originalAllowlist = process.env.RUNTIME_OWNER_GITHUB_LOGIN;
process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.RUNTIME_OWNER_GITHUB_LOGIN = "";
after(() => {
  if (originalKey === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  else process.env.CREDENTIALS_ENCRYPTION_KEY = originalKey;
  if (originalAllowlist === undefined) delete process.env.RUNTIME_OWNER_GITHUB_LOGIN;
  else process.env.RUNTIME_OWNER_GITHUB_LOGIN = originalAllowlist;
});
const origin = "https://app.outrunner.sh";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(32).toString("base64url");
const next = "/new?project=p1&start=codex";
const context = () => desktopContext(state, challenge, next)!;
const user = { id: "owner-1", email: "ada@example.com", app_metadata: {}, user_metadata: {} } as User;

test("desktop context survives OAuth/reloads but expires and rejects tampering and other encrypted data", () => {
  const start = 1000;
  const ctx = desktopContext(state, challenge, next, start)!;
  const cookie = sealDesktopContext(ctx);
  assert.deepEqual(readDesktopContext(cookie, start + 1000), ctx);
  assert.equal(readDesktopContext(cookie, ctx.expires), null);
  assert.equal(readDesktopContext(cookie.slice(0, -8), start), null);
  assert.equal(readDesktopContext(undefined, start), null);
  assert.equal(desktopContext("arbitrary", challenge, next), null);
  assert.equal(desktopContext(state, "bad", next), null);
  assert.equal(readDesktopContext(sealDesktopGrant(ctx, user.id, "otp", origin, next, start), start), null);
});

test("a desktop ticket requires its native verifier, matching state, origin, purpose and a fresh expiry", () => {
  const now = 1000;
  const ctx = desktopContext(state, challenge, next, now)!;
  const ticket = sealDesktopGrant(ctx, user.id, "single-use-otp", origin, next, now);
  assert.equal(ticket.includes("single-use-otp"), false);
  assert.equal(readDesktopGrant(ticket, verifier, state, origin, now)?.next, next);
  assert.equal(readDesktopGrant(ticket, randomBytes(32).toString("base64url"), state, origin, now), null);
  assert.equal(readDesktopGrant(ticket, verifier, "another-attempt", origin, now), null);
  assert.equal(readDesktopGrant(ticket, verifier, state, "https://other.example", now), null);
  assert.equal(readDesktopGrant(ticket, verifier, state, origin, now + 60_000), null);
  assert.equal(readDesktopGrant(ticket.slice(0, -8), verifier, state, origin, now), null);
  assert.equal(readDesktopGrant(sealDesktopContext(ctx), verifier, state, origin, now), null);
});

test("completion keeps the chosen repository/model and refuses outside destinations or auth loops", () => {
  assert.equal(desktopDestination(next), next);
  for (const path of ["https://evil.example", "//evil.example", "/\\evil.example", "/\t/evil.example", "/auth/callback", "/signin?next=/", "/onboarding", "/new/../auth/desktop/ready"]) {
    assert.equal(desktopDestination(path), "/", path);
  }
});

test("handoff generates for the signed-in account and refuses an email/account mismatch or provider error", async () => {
  let generatedFor = "";
  const ticket = await createDesktopTicket({ id: user.id, email: user.email! }, context(), origin, next, async (email) => {
    generatedFor = email;
    return { data: { user, properties: { hashed_token: "one-time-otp" } }, error: null };
  });
  assert.equal(generatedFor, user.email);
  assert.equal(readDesktopGrant(ticket, verifier, state, origin)?.ownerId, user.id);
  for (const result of [
    { data: { user: { id: "different-account" }, properties: { hashed_token: "otp" } }, error: null },
    { data: { user: null, properties: null }, error: new Error("offline") },
  ]) {
    assert.equal(await createDesktopTicket({ id: user.id, email: user.email! }, context(), origin, next, async () => result), null);
  }
});

test("redemption uses a single-use OTP, rejects replay, and never calls auth for a bad PKCE proof", async () => {
  let used = false;
  let calls = 0;
  const ticket = sealDesktopGrant(context(), user.id, "one-time-otp", origin, next);
  const auth = {
    async verifyOtp(params: { token_hash: string; type: "email" }) {
      calls++;
      assert.deepEqual(params, { token_hash: "one-time-otp", type: "email" });
      const data = { user: used ? null : user };
      used = true;
      return { data, error: data.user ? null : new Error("already consumed") };
    },
    async signOut() { assert.fail("should stay signed in"); },
  };
  assert.deepEqual(await redeemDesktopTicket({ ticket, verifier: "bad", state }, origin, auth), { error: "Desktop sign-in expired or was invalid. Start again from the app.", status: 400 });
  assert.equal(calls, 0);
  assert.deepEqual(await redeemDesktopTicket({ ticket, verifier, state }, origin, auth), { next });
  assert.equal((await redeemDesktopTicket({ ticket, verifier, state }, origin, auth) as { status: number }).status, 401);
});

test("an account changed during redemption or removed from the allowlist is signed out locally", async () => {
  const ticket = sealDesktopGrant(context(), user.id, "otp", origin, next);
  for (const changed of [true, false]) {
    process.env.RUNTIME_OWNER_GITHUB_LOGIN = changed ? "" : "only-this-login";
    let scope = "";
    const result = await redeemDesktopTicket({ ticket, verifier, state }, origin, {
      async verifyOtp() { return { data: { user: changed ? { ...user, id: "other" } : user }, error: null }; },
      async signOut(params) { scope = params.scope; },
    });
    assert.equal((result as { status: number }).status, 403);
    assert.equal(scope, "local");
  }
  process.env.RUNTIME_OWNER_GITHUB_LOGIN = "";
});


test("the browser's selected team organization survives the independent desktop session", async () => {
  const orgId = "11111111-1111-4111-8111-111111111111";
  const ticket = await createDesktopTicket({ id: user.id, email: user.email! }, context(), origin, next,
    async () => ({ data: { user, properties: { hashed_token: "otp-for-team" } }, error: null }), orgId);
  const result = await redeemDesktopTicket({ ticket, verifier, state }, origin, {
    async verifyOtp() { return { data: { user }, error: null }; },
    async signOut() { assert.fail("must stay signed in"); },
  });
  assert.deepEqual(result, { next, orgId });
});
