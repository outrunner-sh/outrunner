/**
 * The sidebar's "Get started" checklist: the first things a new user does
 * after onboarding, each ticked off by what the app already knows. Imports no
 * React, so the tests use it as is.
 */

import { providerSettingsHref } from "@/lib/settings-links";

export type GetStartedStep = {
  id: "project" | "session" | "claude";
  label: string;
  /** Where the step is done. */
  href: string;
  done: boolean;
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
      done: claudeConnected === true,
    },
  ];
}

/** Shown until every step is done, or the user skips it. */
export function showGetStarted(steps: GetStartedStep[], skipped: boolean): boolean {
  return !skipped && steps.some((step) => !step.done);
}
