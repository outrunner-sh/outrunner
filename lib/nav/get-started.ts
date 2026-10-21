/**
 * The sidebar's "Get started" checklist: the first things a new user does
 * after onboarding, each ticked off by what the app already knows. Imports no
 * React, so the tests use it as is.
 */

import { providerSettingsHref } from "@/lib/settings-links";

/** Whether the user skipped the checklist: a cookie, so the app layout reads
 *  it on the server and the first paint is already right. Kept on the device,
 *  the card flashed in after hydration for exactly the new users it is for;
 *  the sidebar's own state is a cookie for the same reason (lib/nav/sidebar.ts).
 *  Named again in each instant page's `unstable_instant` samples, which static
 *  analysis reads and so cannot follow this constant. */
export const GET_STARTED_COOKIE = "get-started-skipped";

/** Remember the checklist skipped, for the next page the server renders. */
export function rememberGetStartedSkipped(): void {
  document.cookie = `${GET_STARTED_COOKIE}=1; path=/; max-age=31536000; samesite=lax`;
}

export type GetStartedStep = {
  id: "project" | "session" | "claude";
  label: string;
  /** Where the step is done. */
  href: string;
  /** Null until the app knows; the checklist waits rather than guess. */
  done: boolean | null;
};

export type GetStartedSignals = {
  projects: number;
  /** Sessions in the cloud and on this Mac. */
  sessions: number;
  /** A Claude subscription saved for cloud sessions; null until known. */
  claudeConnected: boolean | null;
};

export function getStartedSteps({ projects, sessions, claudeConnected }: GetStartedSignals): GetStartedStep[] {
  return [
    // The new-session screen is where a repository is picked and becomes a project.
    { id: "project", label: "Create your first project", href: "/new", done: projects > 0 },
    { id: "session", label: "Start your first session", href: "/new", done: sessions > 0 },
    {
      id: "claude",
      label: "Connect Claude sub",
      href: providerSettingsHref("claude", "subscription"),
      done: claudeConnected,
    },
  ];
}

/**
 * Shown until every step is done, or the user skips it. Nothing shows while a
 * step is still unknown: a user who has done everything but whose Claude is
 * still being checked would otherwise see the checklist appear saying 2/3 and
 * vanish a moment later.
 */
export function showGetStarted(steps: GetStartedStep[], skipped: boolean): boolean {
  if (skipped || steps.some((step) => step.done === null)) return false;
  return steps.some((step) => !step.done);
}
