/**
 * Which of a user's own GitHub credentials their work runs as (their GitHub
 * identity "personal", lib/github/identity.ts), first that they have:
 *
 * 1. a personal access token they pasted (lib/db/github-tokens.ts): it
 *    reaches every repository their account can, so it's what they asked for;
 * 2. the Outrunner GitHub App's user token from Settings → Connections;
 * 3. while GITHUB_LEGACY_TOKENS allows it, the token an older sign-in kept.
 *
 * Pure: lib/github/personal.ts wires it to the stores; tests pass their own.
 */

import { GitHubConnectionBrokenError } from "@/lib/github/user-connection";

export type PersonalCredential =
  /** Handed out with no expiry, whatever the token's own: a box's git keeps
   *  a credential until it expires, and one deleted or replaced here should
   *  stop being used within minutes (runtime-agent/internal/gitcred/cache.go).
   *  A box booted with it keeps it as GH_TOKEN, though: only revoking it on
   *  GitHub cuts off a running one. */
  | { source: "pat"; token: string; expiresAt: null; login: string; updatedAt: string }
  | { source: "app_user"; token: string; expiresAt: Date | null }
  | { source: "legacy"; token: string; expiresAt: null };

export type PersonalDeps = {
  pat(userId: string): Promise<{ token: string; login: string; updatedAt: string } | null>;
  /** Throws GitHubConnectionBrokenError when GitHub won't renew it. */
  appUser(userId: string): Promise<{ token: string; expiresAt: Date | null } | null>;
  legacy(userId: string): Promise<string | null>;
};

/**
 * The user's own credential, or null with none. A broken App connection
 * falls back to an old sign-in token where one may be used, else throws
 * GitHubConnectionBrokenError (connect again).
 */
export async function pickPersonalCredential(userId: string, deps: PersonalDeps): Promise<PersonalCredential | null> {
  const pat = await deps.pat(userId);
  if (pat) return { source: "pat", token: pat.token, expiresAt: null, login: pat.login, updatedAt: pat.updatedAt };

  let broken: unknown = null;
  try {
    const user = await deps.appUser(userId);
    if (user) return { source: "app_user", token: user.token, expiresAt: user.expiresAt };
  } catch (error) {
    if (!(error instanceof GitHubConnectionBrokenError)) throw error;
    broken = error;
  }
  const legacy = await deps.legacy(userId);
  if (legacy) return { source: "legacy", token: legacy, expiresAt: null };
  if (broken) throw broken;
  return null;
}

/**
 * Whether the user has connected their own GitHub at all: a token (even one
 * that no longer opens), an App connection (broken or not), or an old sign-in
 * token that may be used. One who has is told to fix it when it fails,
 * rather than quietly working as the App.
 */
export async function isPersonalConnected(
  userId: string,
  deps: { hasToken(userId: string): Promise<boolean>; hasAppConnection(userId: string): Promise<boolean>; hasLegacy(userId: string): Promise<boolean> },
): Promise<boolean> {
  return (await deps.hasToken(userId)) || (await deps.hasAppConnection(userId)) || deps.hasLegacy(userId);
}
