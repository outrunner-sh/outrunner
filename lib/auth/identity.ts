import type { User } from "@supabase/supabase-js";

import type { VerifiedEmail } from "@/lib/orgs/domains";

/** The OAuth providers someone can sign in to Outrunner with. */
export type SignInProvider = "github" | "google";

/**
 * The provider this sign-in came through: the identity GoTrue signed in (or
 * linked) most recently. A user with both GitHub and Google linked gets a
 * `provider_token` from whichever one they just used, and only GitHub's may be
 * stored as their GitHub token. `identities[]` is server-maintained, unlike
 * anything the redirect URL could say.
 */
export function signInProvider(user: User): SignInProvider | "email" | null {
  let latest: { provider: string; at: number } | null = null;
  for (const identity of user.identities ?? []) {
    const at = Date.parse(identity.last_sign_in_at ?? identity.created_at ?? "");
    if (Number.isNaN(at)) continue;
    if (!latest || at > latest.at) latest = { provider: identity.provider, at };
  }
  const provider = latest?.provider;
  return provider === "github" || provider === "google" || provider === "email" ? provider : null;
}

/** Whether the user has a GitHub identity linked (signed in with it, or
 *  connected it later from Settings → Account). */
export function hasGithubIdentity(user: User): boolean {
  return user.identities?.some((i) => i.provider === "github") ?? false;
}

/**
 * The emails verified for the user by their Google identity (Google says so)
 * and their email identity (an emailed code proved it), the first as their
 * primary; none from a provider that hasn't verified one. Read from
 * `identities[].identity_data` and the server-set `email_confirmed_at`, never
 * `user_metadata` (the user's own to write).
 */
export function providerVerifiedEmails(user: User): VerifiedEmail[] {
  const emails: string[] = [];
  for (const identity of user.identities ?? []) {
    const data = (identity.identity_data ?? {}) as Record<string, unknown>;
    const email = data.email;
    if (typeof email !== "string") continue;
    const verified =
      identity.provider === "google"
        ? data.email_verified === true
        : identity.provider === "email" &&
          // An email identity is its account's own email, verified once a code
          // (or link) sent to it was used.
          (data.email_verified === true ||
            (!!user.email_confirmed_at && email.toLowerCase() === user.email?.toLowerCase()));
    if (verified && !emails.some((e) => e.toLowerCase() === email.toLowerCase())) emails.push(email);
  }
  return emails.map((email, i) => ({ email, primary: i === 0 }));
}

/**
 * Every email verified for the user, GitHub's first: GitHub's primary stays
 * the primary when there is one (the domain a team org claims follows it, as
 * before Google and email sign-in), else the other providers' is.
 */
export function mergeVerifiedEmails(github: readonly VerifiedEmail[], others: readonly VerifiedEmail[]): VerifiedEmail[] {
  const seen = new Set(github.map((e) => e.email.toLowerCase()));
  const hasPrimary = github.some((e) => e.primary);
  return [
    ...github,
    ...others
      .filter((e) => !seen.has(e.email.toLowerCase()))
      .map((e) => ({ email: e.email, primary: e.primary && !hasPrimary })),
  ];
}
