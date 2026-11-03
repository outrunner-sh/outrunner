/**
 * The rules of the old sign-in tokens' cutover (lib/github/legacy-token.ts),
 * pure, for tests.
 */

export type LegacyTokenMode = "store" | "fallback" | "off";

/** The mode `value` (GITHUB_LEGACY_TOKENS) says, or the default for whether
 *  users can connect through the App. */
export function legacyModeFrom(value: string | undefined, userAuthConfigured: boolean): LegacyTokenMode {
  const chosen = value?.trim().toLowerCase();
  if (chosen === "store" || chosen === "fallback" || chosen === "off") return chosen;
  return userAuthConfigured ? "fallback" : "store";
}

/** What signing in with GitHub asks for: who the user is and their verified
 *  emails (admission, invites, a team org's domain); `repo` only in `store`. */
export function signInScopesFor(mode: LegacyTokenMode): string {
  return mode === "store" ? "read:user user:email repo" : "read:user user:email";
}

