/**
 * Which source an org's repositories are listed from
 * (lib/github/repository-source.ts wires it up). Pure, for tests.
 */

import type { PersonalCredential } from "@/lib/github/personal-choice";

/** Which source an org lists from (pickRepositorySource). */
export type SourceChoice =
  | "pat" // the user's own personal access token: everything their account reaches
  | "user_app" // the App's user token: what both they and the App reach
  | "app" // the org's installations, as the App
  | "legacy" // an old sign-in token
  | "missing" // nothing to list with: connect GitHub
  | "no_installation"; // a team org without the App

/**
 * Where an org's repositories come from. A team org only ever lists what its
 * App's installations reach: a member's own GitHub, token or connection,
 * never lands in it. The user's own personal org lists their personal access
 * token first, then their App user token, then the org's installations, then
 * an old sign-in token.
 */
export function pickRepositorySource(input: {
  personal: boolean;
  installations: number;
  own: PersonalCredential["source"] | null;
}): SourceChoice {
  if (!input.personal) return input.installations > 0 ? "app" : "no_installation";
  if (input.own === "pat") return "pat";
  if (input.own === "app_user") return "user_app";
  if (input.installations > 0) return "app";
  return input.own === "legacy" ? "legacy" : "missing";
}
