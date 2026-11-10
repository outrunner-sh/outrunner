/**
 * The rules of the old sign-in tokens' cutover (lib/github/legacy-token.ts),
 * pure, for tests.
 */

export type LegacyTokenMode = "store" | "fallback" | "off";

/** The mode `value` (GITHUB_LEGACY_TOKENS) says; `store` when it's unset or
 *  unknown, so deploying this changes nothing until a deployment opts in to
 *  `fallback` (whether or not the App's client secret is already set). */
export function legacyModeFrom(value: string | undefined): LegacyTokenMode {
  const chosen = value?.trim().toLowerCase();
  if (chosen === "store" || chosen === "fallback" || chosen === "off") return chosen;
  return "store";
}

/** What signing in with GitHub asks for: who the user is and their verified
 *  emails (admission, invites, a team org's domain); `repo` only in `store`. */
export function signInScopesFor(mode: LegacyTokenMode): string {
  return mode === "store" ? "read:user user:email repo" : "read:user user:email";
}

