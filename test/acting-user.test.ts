import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { ActAsUserError, actAsUser, actingUserClient } from "@/lib/supabase/acting-user";

const USER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const realFetch = globalThis.fetch;
const env = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...env };
});

/** Supabase Auth, as far as acting as a user goes; each call recorded. */
function stubAuth({ email = "dev@example.test", verifiedAs = USER } = {}) {
  const calls: string[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const user = { id: USER, aud: "authenticated", email, app_metadata: {}, user_metadata: {}, created_at: "" };
    if (url.pathname === `/auth/v1/admin/users/${USER}`) return Promise.resolve(Response.json(user));
    if (url.pathname === "/auth/v1/admin/generate_link") {
      return Promise.resolve(Response.json({ ...user, hashed_token: "hashed", action_link: "", email_otp: "", redirect_to: "", verification_type: "magiclink" }));
    }
    if (url.pathname === "/auth/v1/verify") {
      return Promise.resolve(
        Response.json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: "bearer",
          user: { ...user, id: verifiedAs },
        }),
      );
    }
    if (url.pathname === "/auth/v1/logout") return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;
  return calls;
}

test("work runs signed in as the user, with their client, and their session ends after", async () => {
  const calls = stubAuth();
  assert.equal(actingUserClient(), undefined);
  const seen = await actAsUser(USER, async () => {
    const client = actingUserClient();
    assert.ok(client);
    return (await client.auth.getSession()).data.session?.access_token;
  });
  assert.equal(seen, "access");
  assert.equal(actingUserClient(), undefined);
  assert.deepEqual(calls, [
    `GET /auth/v1/admin/users/${USER}`,
    "POST /auth/v1/admin/generate_link",
    "POST /auth/v1/verify",
    "POST /auth/v1/logout",
  ]);
});

test("the session ends even when the work fails", async () => {
  const calls = stubAuth();
  await assert.rejects(
    actAsUser(USER, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(calls.at(-1), "POST /auth/v1/logout");
});

test("a user without an email, or a sign-in as someone else, is refused before any work", async () => {
  stubAuth({ email: "" });
  let ran = false;
  await assert.rejects(
    actAsUser(USER, async () => {
      ran = true;
    }),
    ActAsUserError,
  );
  stubAuth({ verifiedAs: "11111111-1111-4111-8111-111111111111" });
  await assert.rejects(
    actAsUser(USER, async () => {
      ran = true;
    }),
    ActAsUserError,
  );
  assert.equal(ran, false);
});
