/**
 * What the first cloud session from onboarding starts on. Onboarding never
 * asks for Claude: Outrunner's models are the default, and a user who wants
 * their Claude subscription or their own key connects it in Settings →
 * Providers. Imports nothing, so the tests use it as is.
 */

/** What a cloud session starts on; null until that is known, or with nothing to start on. */
export type CloudModel = "claude" | "outrunner" | null;

export type CloudModelSignals = {
  /** A Claude connection saved with the account; null while it's checked. */
  connected: boolean | null;
  /** Whether the server runs Outrunner's models. */
  outrunnerModels: boolean;
};

/**
 * Outrunner's models wherever the server has them, even for a user with
 * Claude: that is the default, and the session's model menu switches it.
 * Without them, a Claude connection already saved (made in Settings before
 * onboarding) is the only thing to start on; null while that is checked, and
 * null without it.
 */
export function startingCloudModel({ connected, outrunnerModels }: CloudModelSignals): CloudModel {
  if (outrunnerModels) return "outrunner";
  return connected === true ? "claude" : null;
}
