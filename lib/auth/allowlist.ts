import type { User } from "@supabase/supabase-js";

import { optionalEnv } from "@/lib/env";

/**
 * Parse the `RUNTIME_OWNER_GITHUB_LOGIN` allowlist — a comma- or
 * whitespace-separated list of GitHub logins — into a lowercased set. Empty
 * entries are ignored, so a blank value yields an empty set (rejects everyone).
 * A single login is still valid; the list form just admits a small shared team.
 *
 * Kept free of server-only imports so it stays unit-testable.
 */
export function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== ""),
  );
}

/**
 * Whether this user may use the deployment.
 *
 * Sign-up is open: anyone who authenticates (GitHub, Google, or an emailed
 * code) gets in. What keeps
 * users apart is not this check but the data model — every row carries
 * `owner_id` and RLS restricts it to `auth.uid()`, so each account sees only
 * its own projects and workspaces, and each runs on credentials it supplied
 * itself (see lib/db/credentials.ts).
 *
 * When restricted, requiring a GitHub identity is still meaningful.
 * {@link githubLogin} reads `identities[]`, so the allowlist matches only a
 * GitHub identity GoTrue maintains — never a name some other provider's user
 * set on themselves. Someone signed in with Google or email alone gets past a
 * restricted allowlist only as an org admits them.
 *
 * `RUNTIME_OWNER_GITHUB_LOGIN` narrows access back to a named allowlist when
 * set. Leave it unset for open sign-up; set it to keep a deployment private.
 * Note the polarity: unset means OPEN here, where it used to mean CLOSED.
 */
export function isOwner(user: User): boolean {
  const allowed = parseAllowlist(optionalEnv("RUNTIME_OWNER_GITHUB_LOGIN"));

  // Open sign-up: anyone Supabase authenticated is in. Deliberately decided
  // BEFORE looking at the GitHub login, because that lookup reads
  // `user.identities[].identity_data`, which is not guaranteed to be populated
  // on every session. Resolving it first made open sign-up silently depend on
  // it: the gate admitted the account whose identity data happened to be there
  // and rejected another with "Sign in as the Runtime owner", on a deployment
  // configured to admit everyone.
  if (allowed.size === 0) return true;

  // Let in past the list: invited to an org, or approved to join one
  // (lib/orgs/admission.ts). app_metadata, unlike user_metadata, only the
  // server (service role) can write.
  if (isAdmitted(user)) return true;

  // Restricted: now the login genuinely matters, and no login means no match.
  return onAllowlist(user, allowed);
}

/** Whether the user's GitHub login is on `RUNTIME_OWNER_GITHUB_LOGIN` itself,
 *  admitted to an org or not. An empty list has no one on it. */
export function onAllowlist(user: User, allowed = parseAllowlist(optionalEnv("RUNTIME_OWNER_GITHUB_LOGIN"))): boolean {
  const login = githubLogin(user)?.toLowerCase();
  return login != null && allowed.has(login);
}

/** The app_metadata key that lets a user in past the allowlist. */
export const ADMITTED_KEY = "outrunner_admitted";

/** Whether an org let this user in past the allowlist (an invite accepted, a
 *  request approved). Set and cleared by the server alone. */
export function isAdmitted(user: User): boolean {
  return (user.app_metadata as Record<string, unknown> | undefined)?.[ADMITTED_KEY] === true;
}

/**
 * The GitHub username, read from the server-maintained OAuth identity — NOT
 * from `user_metadata`.
 *
 * `user_metadata` is writable by the user (`auth.updateUser({ data })`), so if
 * any other Supabase provider is enabled (email/password, magic link, …) a
 * non-GitHub user could set `user_name` to the owner's login and pass the
 * allowlist. `identities[].identity_data` is populated by GoTrue from the
 * provider on each sign-in and is not client-writable, and requiring a
 * `github` identity also enforces that the session actually came from GitHub.
 */
export function githubLogin(user: User): string | null {
  const identity = user.identities?.find((i) => i.provider === "github");
  if (!identity) return null;

  const data = (identity.identity_data ?? {}) as Record<string, unknown>;
  const login = data.user_name ?? data.preferred_username ?? data.login;
  return typeof login === "string" ? login : null;
}

/**
 * The GitHub user's numeric id, from the same server-maintained identity as
 * {@link githubLogin}. Unlike a login it never changes, and is never given to
 * anyone else: what an installation's installer is matched by
 * (lib/db/github-installations.ts). Null for a session not from GitHub.
 */
export function githubUserId(user: User): number | null {
  const identity = user.identities?.find((i) => i.provider === "github");
  if (!identity) return null;
  const data = (identity.identity_data ?? {}) as Record<string, unknown>;
  const raw = data.provider_id ?? data.sub ?? identity.id;
  const id = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
