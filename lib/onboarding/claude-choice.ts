/**
 * Whether onboarding offers Connect Claude, and what the first cloud session
 * starts on. Outrunner's own models are the default: Claude is offered only to
 * a user who has it (a connection already saved, or Claude Code logged in on
 * this Mac), or where the server has no models of its own to start on.
 * Imports nothing, so the tests use it as is.
 */

/** What a cloud session starts on; null until that is known, or chosen. */
export type CloudModel = "claude" | "outrunner" | null;

/** `hidden`: the row isn't shown. `optional`: shown, but the session starts
 *  without it. `required`: no session starts until it's connected. */
export type ClaudeOffer = "hidden" | "optional" | "required";

export type ClaudeSignals = {
  /** A Claude connection saved with the account; null while it's checked. */
  connected: boolean | null;
  /** Claude Code logged in on this Mac; null while it's checked, false
   *  outside the Mac app. */
  onMac: boolean | null;
  /** Whether the server runs Outrunner's models. */
  outrunnerModels: boolean;
};

export function claudeOffer({ connected, onMac, outrunnerModels }: ClaudeSignals): ClaudeOffer {
  // Without Outrunner's models a session has nothing else to start on.
  if (!outrunnerModels) return "required";
  return connected === true || onMac === true ? "optional" : "hidden";
}

/**
 * The model a cloud session starts on before the user does anything: their
 * Claude once it's connected (they chose it), else Outrunner's. Null while the
 * saved connection is still being checked, so Start can't go out on Outrunner's
 * a moment before Claude is found; and null without either.
 *
 * Only the saved connection decides it: Claude Code on this Mac merely offers
 * the row, so its slower check never holds Start up.
 */
export function startingCloudModel({ connected, outrunnerModels }: Omit<ClaudeSignals, "onMac">): CloudModel {
  if (connected === null) return null;
  if (connected) return "claude";
  return outrunnerModels ? "outrunner" : null;
}
