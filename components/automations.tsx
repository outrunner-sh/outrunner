"use client";

import { Github, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { InlineMessage } from "@/components/ui/notice";
import { type Automation, TRIGGER_LABELS } from "@/lib/automations/rules";
import { CONNECTOR_NAME } from "@/lib/automations/connector-name";
import type { AutomationTemplate } from "@/lib/automations/templates";
import type { AutomationRun } from "@/lib/db/automation-runs";
import { requestJson } from "@/lib/http/request-json";
import type { Org } from "@/lib/orgs/active";
import { cn } from "@/lib/utils";

/**
 * The Automations page for the org the app is showing: the org's
 * automations, which its admins switch on and off and open to change; the
 * templates to start one from; and whether the Outrunner GitHub App, whose
 * events start them and which posts their results, is installed (that's
 * Settings → Org → GitHub).
 */
export function Automations({
  org,
  appSlug,
  installations,
  automations,
  runs,
  templates,
}: {
  org: Org;
  /** Null when this deployment has no GitHub App set up. */
  appSlug: string | null;
  /** The accounts the app is installed on for the org; null when they
   *  couldn't be read. */
  installations: { login: string; suspended: boolean }[] | null;
  /** Null when they couldn't be read. */
  automations: Automation[] | null;
  /** Their latest runs, newest first; null when they couldn't be read. */
  runs: AutomationRun[] | null;
  templates: Pick<AutomationTemplate, "id" | "name" | "description" | "category">[];
}) {
  const admin = org.role === "admin";

  return (
    <div className="px-8 py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h1 className="text-lg font-semibold text-foreground">Automations</h1>
            <p className="text-[13px] text-muted-foreground">
              Shared workflows for {org.personal ? "your personal org" : org.name}: a session that starts on its own,
              like a code review on every pull request.
            </p>
          </div>
          {admin ? (
            <Link href="/automations/new" className={cn(buttonVariants({ size: "sm" }), "shrink-0")}>
              <Plus /> Create automation
            </Link>
          ) : null}
        </header>

        <GitHubAppStatus appSlug={appSlug} installations={installations} admin={admin} />

        <AutomationList orgId={org.id} automations={automations} admin={admin} byConnector={!org.personal} />

        {automations?.length ? <RecentRuns orgId={org.id} runs={runs} admin={admin} byConnector={!org.personal} /> : null}

        {admin && templates.length > 0 ? (
          <section className="space-y-2">
            <div className="space-y-0.5">
              <h2 className="text-[13px] font-medium text-foreground">Templates</h2>
              <p className="text-xs text-muted-foreground">Start from a ready prompt; change anything before you save.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {templates.map((template) => (
                <Link
                  key={template.id}
                  href={`/automations/new?template=${encodeURIComponent(template.id)}`}
                  className="space-y-1.5 rounded-lg border border-border/60 p-3 transition-colors hover:bg-accent"
                >
                  <div className="text-xs text-positive">{template.category}</div>
                  <div className="text-[13px] font-medium text-foreground">{template.name}</div>
                  <div className="text-xs text-muted-foreground">{template.description}</div>
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** One line on the Outrunner GitHub App: what automations post as, and where
 *  it's installed (Settings → Org → GitHub, where its admins install it). */
function GitHubAppStatus({
  appSlug,
  installations,
  admin,
}: {
  appSlug: string | null;
  installations: { login: string; suspended: boolean }[] | null;
  admin: boolean;
}) {
  const accounts = installations?.map((i) => (i.suspended ? `${i.login} (suspended on GitHub)` : i.login));
  const detail =
    appSlug === null
      ? "Not set up on this deployment yet, so automations can't run."
      : installations === null
        ? "Couldn't load where it's installed. Reload the page to try again."
        : installations.length === 0
          ? `Not installed for this org yet: automations run once ${admin ? "it is" : "an admin installs it"}, and post as ${appSlug}[bot].`
          : `Automations post as ${appSlug}[bot]. Installed on ${accounts?.join(", ")}.`;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-[13px]">
      <Github className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <span className="text-foreground">Outrunner GitHub App</span>
        <span className="text-muted-foreground"> · {detail}</span>
      </div>
      {appSlug !== null ? (
        <Link href="/settings/org/github" className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground">
          {installations?.length || !admin ? "Manage" : "Install"}
        </Link>
      ) : null}
    </div>
  );
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The org's automations: name, triggers, repositories, on or off (an admin
 *  switches it here), when made and who it runs as. */
function AutomationList({
  orgId,
  automations,
  admin,
  byConnector,
}: {
  orgId: string;
  automations: Automation[] | null;
  admin: boolean;
  /** A team org's: they run as its connector, not a member. */
  byConnector: boolean;
}) {
  const router = useRouter();
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setEnabled = async (automation: Automation) => {
    if (switching) return;
    setSwitching(automation.id);
    setError(null);
    try {
      await requestJson(`/api/orgs/${orgId}/automations/${automation.id}`, {
        method: "PATCH",
        body: { enabled: !automation.enabled },
        fallback: "Couldn't change it. Try again.",
      });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't change it. Try again.");
    } finally {
      setSwitching(null);
    }
  };

  return (
    <section className="space-y-2">
      <h2 className="text-[13px] font-medium text-foreground">Automations</h2>
      {automations === null ? (
        <p className="text-[13px] text-muted-foreground">Couldn&apos;t load the automations. Reload the page to try again.</p>
      ) : automations.length === 0 ? (
        <p className="rounded-lg border border-border/60 px-3 py-6 text-center text-[13px] text-muted-foreground">
          No automations yet.{admin ? " Start one from a template below." : ""}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full text-[13px]">
            <thead className="bg-muted/30 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">Name</th>
                <th className="px-3 py-2 font-normal">Trigger</th>
                <th className="px-3 py-2 font-normal">Repositories</th>
                <th className="px-3 py-2 font-normal">Status</th>
                <th className="px-3 py-2 font-normal">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {automations.map((automation) => (
                <tr key={automation.id}>
                  <td className="px-3 py-2.5">
                    <Link href={`/automations/${automation.id}`} className="text-foreground hover:underline">
                      {automation.name}
                    </Link>
                    {byConnector ? (
                      <div className="text-xs text-muted-foreground">Runs as {CONNECTOR_NAME}</div>
                    ) : automation.runsAs?.login ? (
                      <div className="text-xs text-muted-foreground">Runs as @{automation.runsAs.login}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {automation.triggers.map((trigger) => (
                        <span key={trigger} className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground/80">
                          {TRIGGER_LABELS[trigger]}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-foreground/75">
                    {automation.repos.length === 0
                      ? "None"
                      : `${automation.repos[0].fullName}${automation.repos.length > 1 ? ` +${automation.repos.length - 1}` : ""}`}
                  </td>
                  <td className="px-3 py-2.5">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={automation.enabled}
                      aria-label={`${automation.name}: ${automation.enabled ? "enabled" : "disabled"}`}
                      disabled={!admin || switching !== null}
                      onClick={() => void setEnabled(automation)}
                      className="flex items-center gap-2 text-xs text-muted-foreground disabled:cursor-default"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "relative h-4 w-7 rounded-full transition-colors",
                          automation.enabled ? "bg-primary" : "bg-muted-foreground/30",
                        )}
                      >
                        <span
                          className={cn(
                            "absolute top-0.5 size-3 rounded-full bg-background transition-[left]",
                            automation.enabled ? "left-3.5" : "left-0.5",
                          )}
                        />
                      </span>
                      {automation.enabled ? "Enabled" : "Disabled"}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{DATE.format(new Date(automation.createdAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}
    </section>
  );
}

const RUN_STATUS: Record<AutomationRun["status"], { label: string; tone: string }> = {
  started: { label: "Starting", tone: "text-muted-foreground" },
  ready: { label: "Running", tone: "text-positive" },
  failed: { label: "Failed", tone: "text-destructive" },
  refused: { label: "Didn't start", tone: "text-warning" },
};

const WHEN = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

/** The org's latest runs: which automation, on which pull request and
 *  commit, how it went, and the session it started. */
function RecentRuns({
  orgId,
  runs,
  admin,
  byConnector,
}: {
  orgId: string;
  runs: AutomationRun[] | null;
  admin: boolean;
  byConnector: boolean;
}) {
  const router = useRouter();
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One that failed or didn't start, on its pull request's head as it is now.
  const rerun = async (run: AutomationRun) => {
    if (rerunning) return;
    setRerunning(run.id);
    setError(null);
    try {
      await requestJson(`/api/orgs/${orgId}/automations/runs/${run.id}`, {
        method: "POST",
        fallback: "Couldn't run it again. Try again.",
      });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't run it again. Try again.");
    } finally {
      setRerunning(null);
    }
  };

  return (
    <section className="space-y-2">
      <h2 className="text-[13px] font-medium text-foreground">Recent runs</h2>
      {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}
      {runs === null ? (
        <p className="text-[13px] text-muted-foreground">Couldn&apos;t load the runs. Reload the page to try again.</p>
      ) : runs.length === 0 ? (
        <p className="rounded-lg border border-border/60 px-3 py-6 text-center text-[13px] text-muted-foreground">
          No runs yet. One starts when a pull request on an automation&apos;s repository is opened or gets new commits.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full text-[13px]">
            <thead className="bg-muted/30 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">Pull request</th>
                <th className="px-3 py-2 font-normal">Automation</th>
                <th className="px-3 py-2 font-normal">Status</th>
                <th className="px-3 py-2 font-normal">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {runs.map((run) => {
                const status = RUN_STATUS[run.status];
                return (
                  <tr key={run.id} className="align-top">
                    <td className="px-3 py-2.5">
                      <a
                        href={`https://github.com/${run.repoFullName}/pull/${run.prNumber}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-foreground hover:underline"
                      >
                        {run.repoFullName}#{run.prNumber}
                      </a>
                      <div className="max-w-xs truncate text-xs text-muted-foreground">
                        {run.prTitle ? `${run.prTitle} · ` : ""}
                        <span className="font-mono">{run.headSha.slice(0, 7)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-foreground/75">{run.automationName}</td>
                    <td className="px-3 py-2.5">
                      <div className={status.tone}>{status.label}</div>
                      {run.reason ? <div className="max-w-xs text-xs text-muted-foreground">{run.reason}</div> : null}
                      {/* A connector's session is its own, not a member's to open:
                          its admins read it, read-only. */}
                      {run.workspaceId && !byConnector ? (
                        <Link href={`/workspaces/${run.workspaceId}`} className="text-xs text-muted-foreground hover:underline">
                          Open session
                        </Link>
                      ) : run.workspaceId && admin ? (
                        <Link href={`/automations/runs/${run.id}`} className="block text-xs text-muted-foreground hover:underline">
                          View session
                        </Link>
                      ) : null}
                      {admin && (run.status === "failed" || run.status === "refused") ? (
                        <button
                          type="button"
                          onClick={() => void rerun(run)}
                          disabled={rerunning !== null}
                          className="block text-xs text-muted-foreground hover:text-foreground hover:underline disabled:opacity-60"
                        >
                          {rerunning === run.id ? "Starting…" : "Run again"}
                        </button>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">{WHEN.format(new Date(run.createdAt))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
