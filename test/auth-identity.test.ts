import assert from "node:assert/strict";
import { test } from "node:test";

import type { User } from "@supabase/supabase-js";

import { hasGithubIdentity, mergeVerifiedEmails, providerVerifiedEmails, signInProvider } from "@/lib/auth/identity";

function user(identities: unknown[], extra: Record<string, unknown> = {}): User {
  return { identities, ...extra } as unknown as User;
}

test("the sign-in's provider is the identity signed in most recently", () => {
  const both = user([
    { provider: "github", last_sign_in_at: "2026-10-01T00:00:00Z", identity_data: {} },
    { provider: "google", last_sign_in_at: "2026-10-27T00:00:00Z", identity_data: {} },
  ]);
  assert.equal(signInProvider(both), "google");
  // Just linked GitHub: it's the newest.
  const linked = user([
    { provider: "google", last_sign_in_at: "2026-10-27T00:00:00Z", identity_data: {} },
    { provider: "github", created_at: "2026-10-27T00:05:00Z", identity_data: {} },
  ]);
  assert.equal(signInProvider(linked), "github");
  assert.equal(signInProvider(user([])), null);
  // A provider Outrunner doesn't sign in with is none of its own.
  assert.equal(signInProvider(user([{ provider: "azure", last_sign_in_at: "2026-10-27T00:00:00Z" }])), null);
  assert.equal(signInProvider({} as User), null);
});

test("Google's email counts only when Google verified it, and only from the identity", () => {
  const google = (data: Record<string, unknown>) => user([{ provider: "google", identity_data: data }]);
  assert.deepEqual(providerVerifiedEmails(google({ email: "ada@acme.dev", email_verified: true })), [
    { email: "ada@acme.dev", primary: true },
  ]);
  assert.deepEqual(providerVerifiedEmails(google({ email: "ada@acme.dev", email_verified: false })), []);
  assert.deepEqual(providerVerifiedEmails(google({ email: "ada@acme.dev" })), []);
  // user_metadata is the user's own to write: it vouches for nothing.
  assert.deepEqual(
    providerVerifiedEmails(user([], { user_metadata: { email: "ceo@acme.dev", email_verified: true } })),
    [],
  );
});

test("GitHub's primary stays primary; Google's fills in when GitHub has none", () => {
  const github = [
    { email: "ada@acme.dev", primary: true },
    { email: "ada@old.dev", primary: false },
  ];
  const google = [{ email: "ada@gmail.com", primary: true }];
  assert.deepEqual(mergeVerifiedEmails(github, google), [...github, { email: "ada@gmail.com", primary: false }]);
  assert.deepEqual(mergeVerifiedEmails([], google), google);
  // The same email from both is listed once.
  assert.deepEqual(mergeVerifiedEmails(github, [{ email: "ADA@acme.dev", primary: true }]), github);
});

test("a GitHub identity is one GoTrue linked, whatever the user signed in with", () => {
  assert.equal(hasGithubIdentity(user([{ provider: "google" }])), false);
  assert.equal(hasGithubIdentity(user([{ provider: "google" }, { provider: "github" }])), true);
  assert.equal(hasGithubIdentity({} as User), false);
});

test("an email identity's email counts once a code sent to it was used", () => {
  const emailUser = (confirmed: boolean) =>
    user([{ provider: "email", identity_data: { email: "ada@acme.dev" } }], {
      email: "ada@acme.dev",
      email_confirmed_at: confirmed ? "2026-10-27T00:00:00Z" : null,
    });
  assert.deepEqual(providerVerifiedEmails(emailUser(true)), [{ email: "ada@acme.dev", primary: true }]);
  assert.deepEqual(providerVerifiedEmails(emailUser(false)), []);
  // Google's and the code's, for the same address, are one email.
  const both = user(
    [
      { provider: "google", identity_data: { email: "ada@acme.dev", email_verified: true } },
      { provider: "email", identity_data: { email: "ADA@acme.dev", email_verified: true } },
    ],
    { email: "ada@acme.dev" },
  );
  assert.deepEqual(providerVerifiedEmails(both), [{ email: "ada@acme.dev", primary: true }]);
});
