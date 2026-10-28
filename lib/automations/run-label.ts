/**
 * What a run is about, as the run list and its session's page name it: a
 * pull request's run, its pull request and commit; an issue's, the issue; a
 * schedule's or a webhook's, its repository and when. No I/O, for the page's client components.
 */

import type { AutomationRun } from "@/lib/db/automation-runs";

const DUE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

export type RunSubject = {
  /** Its name: `owner/name#7`, or the repository. */
  title: string;
  /** Where it is on GitHub, if anywhere. */
  href: string | null;
  /** A line under it: the pull request's title, or the schedule's time. */
  detail: string | null;
  /** A pull request's head, short. */
  commit: string | null;
};

export function runSubject(
  run: Pick<
    AutomationRun,
    "repoFullName" | "trigger" | "prNumber" | "prTitle" | "headSha" | "scheduledFor" | "createdAt" | "issueNumber"
  >,
): RunSubject {
  if (run.issueNumber !== null) {
    return {
      title: `${run.repoFullName}#${run.issueNumber}`,
      href: `https://github.com/${run.repoFullName}/issues/${run.issueNumber}`,
      detail: run.prTitle || null,
      commit: null,
    };
  }
  if (run.prNumber !== null) {
    return {
      title: `${run.repoFullName}#${run.prNumber}`,
      href: `https://github.com/${run.repoFullName}/pull/${run.prNumber}`,
      detail: run.prTitle || null,
      commit: run.headSha?.slice(0, 7) ?? null,
    };
  }
  return {
    title: run.repoFullName,
    href: `https://github.com/${run.repoFullName}`,
    detail: run.scheduledFor
      ? `Scheduled for ${DUE.format(new Date(run.scheduledFor))}`
      : run.trigger === "webhook"
        ? `Webhook, ${DUE.format(new Date(run.createdAt))}`
        : null,
    commit: null,
  };
}
