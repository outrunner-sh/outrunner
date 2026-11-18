/**
 * Setup, per org (components/onboarding/onboarding-flow.tsx): its coding
 * agent, GitHub, the repositories it works on and its first environment,
 * then a first session. Which org needs it, and who sees what, apart from
 * the reads (setup.deps.ts), so the rule tests on its own.
 */

import type { OrgRole } from "@/lib/orgs/active";

/** What decides whether an org needs setup, as the database has it. */
export type OrgSetupState = {
  /** When setup was finished, or skipped, for the org; null for never. */
  setupCompletedAt: string | null;
  /** Whether anyone has had a session in it (any state, any member). */
  hasWorkspace: boolean;
  /** Its environments (not archived), each the repository it's the own
   *  environment of, or null for one someone made. */
  environments: readonly { defaultForProjectId: string | null }[];
};

/**
 * Whether the org still needs setup: never finished or skipped, no session
 * yet, and no environment anyone made. Not merely "no environment": every
 * org that has had a session has its repositories' own environments, made
 * on first use, and those say nothing about whether anyone set it up.
 */
export function needsSetup(state: OrgSetupState): boolean {
  if (state.setupCompletedAt) return false;
  if (state.hasWorkspace) return false;
  return !state.environments.some((e) => e.defaultForProjectId === null);
}

/** What home does about it: an admin is sent through setup; a member waits
 *  for one, with what they can do meanwhile. Null: nothing to do. */
export type SetupGate = { kind: "setup" } | { kind: "waiting"; orgName: string } | null;

export function setupGate(needed: boolean, org: { role: OrgRole; name: string; personal: boolean }): SetupGate {
  if (!needed) return null;
  if (org.role === "admin") return { kind: "setup" };
  return { kind: "waiting", orgName: org.personal ? "your personal org" : org.name };
}
