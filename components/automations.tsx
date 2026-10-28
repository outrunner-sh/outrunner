"use client";

import { ArrowRight, Github, GitPullRequest, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { SettingsTabs } from "@/components/settings-tabs";
import { buttonVariants } from "@/components/ui/button";
import { InlineMessage } from "@/components/ui/notice";
import { useNow } from "@/hooks/use-now";
import { type Automation, type AutomationTrigger, TRIGGER_LABELS } from "@/lib/automations/rules";
import { CONNECTOR_NAME } from "@/lib/automations/connector-name";
import type { AutomationTemplate } from "@/lib/automations/templates";
import type { AutomationRun } from "@/lib/db/automation-runs";
import { requestJson } from "@/lib/http/request-json";
import { relativeTime } from "@/lib/nav/sidebar";
import type { Org } from "@/lib/orgs/active";
import { cn } from "@/lib/utils";

type TemplateCard = Pick<AutomationTemplate, "id" | "name" | "description" | "category" | "triggers">;

/**
 * The Automations page for the org the app is showing: the org's
 * automations, which its admins switch on and off and open to change; the
 * templates to start one from; their recent runs; and whether the Outrunner
 * GitHub App, whose events start them and which posts their results, is
 * installed (that's Settings → Org → GitHub).
 */
export function Automations({
  org,
  appSlug,
  installations,
  automations,
  runs,
  runsLimit,
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
  /** How many runs are loaded at most: as many as that means there may be
   *  more. */
  runsLimit: number;
  templates: TemplateCard[];
}) {
  const admin = org.role === "admin";
  // One clock for every "5m ago" on the page, so they age together.
  const now = useNow(60_000);
  // Templates first: they're how an automation starts. Runs only once there
  // are automations to have run.
  const tabs: Tab[] = [
    ...(admin && templates.length > 0 ? (["templates"] as const) : []),
    ...(automations?.length ? (["runs"] as const) : []),
  ];
  const [picked, setPicked] = useState<Tab>(tabs[0] ?? "templates");
  // The tab picked may be gone after a refresh (the last automation deleted).
  const active = tabs.includes(picked) ? picked : tabs[0];
  const count: Record<Tab, string | null> = {
    templates: templates.length ? String(templates.length) : null,
    // A full page of runs isn't all of them: "50+", not a total.
    runs: runs?.length ? `${runs.length}${runs.length >= runsLimit ? "+" : ""}` : null,
  };

  // The page fills the pane and the tab under the automations takes what's
  // left, scrolling on its own, so a long list of runs doesn't scroll the
  // header and the automations away with it.
  return (
    <div className="flex h-full flex-col px-8 py-8">
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-6">
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

        <AutomationList
          orgId={org.id}
          automations={automations}
          runs={runs}
          now={now}
          admin={admin}
          byConnector={!org.personal}
        />

        {active ? (
          <section className="flex min-h-64 flex-1 flex-col gap-3">
            <SettingsTabs
              ids={tabs}
              active={active}
              onOpen={setPicked}
              label="Automations"
              idPrefix="automations"
              tabLabel={(id) => (
                <>
                  {TAB_LABELS[id]}
                  {count[id] ? <span className="text-xs tabular-nums text-muted-foreground">{count[id]}</span> : null}
                </>
              )}
            />
            <div
              role="tabpanel"
              id={`automations-panel-${active}`}
              aria-labelledby={`automations-tab-${active}`}
              className="flex min-h-0 flex-1 flex-col"
            >
              {active === "templates" ? (
                <TemplateGrid templates={templates} />
              ) : (
                <RecentRuns orgId={org.id} runs={runs} now={now} admin={admin} byConnector={!org.personal} />
              )}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

type Tab = "templates" | "runs";

const TAB_LABELS: Record<Tab, string> = { templates: "Templates", runs: "Recent runs" };

/** A trigger as a chip, the same in the automations' rows and on templates. */
function TriggerChips({ triggers }: { triggers: AutomationTrigger[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {triggers.map((trigger) => (
        <span key={trigger} className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground/80">
          {TRIGGER_LABELS[trigger]}
        </span>
      ))}
    </div>
  );
}

/** Starting points for a new automation: a blank one, then each template,
 *  which opens the editor with its prompt and triggers filled in. */
function TemplateGrid({ templates }: { templates: TemplateCard[] }) {
  return (
    <div className="min-h-0 overflow-y-auto">
      <div className="grid auto-rows-fr gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/automations/new"
          className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-4 text-center transition-colors hover:bg-accent"
        >
          <span className="grid size-8 place-items-center rounded-md bg-muted text-muted-foreground">
            <Plus className="size-4" />
          </span>
          <span className="text-[13px] font-medium text-foreground">Start from scratch</span>
          <span className="text-xs text-muted-foreground">Write your own prompt and pick its triggers.</span>
        </Link>
        {templates.map((template) => (
          <Link
            key={template.id}
            href={`/automations/new?template=${encodeURIComponent(template.id)}`}
            className="group flex flex-col gap-3 rounded-lg border border-border/60 p-4 transition-colors hover:border-border hover:bg-accent/50"
          >
            <div className="flex items-center gap-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-positive/10 text-positive">
                <GitPullRequest className="size-4" />
              </span>
              <span className="text-xs text-muted-foreground">{template.category}</span>
            </div>
            <div className="flex-1 space-y-1">
              <div className="text-[13px] font-medium text-foreground">{template.name}</div>
              <div className="text-xs text-muted-foreground">{template.description}</div>
            </div>
            <div className="flex items-end justify-between gap-2">
              <TriggerChips triggers={template.triggers} />
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
                Use template <ArrowRight className="size-3" />
              </span>
            </div>
          </Link>
        ))}
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

const WHEN = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

/** How long ago, "5m ago", with the exact time on hover. */
function Ago({ at, now }: { at: string; now: number }) {
  const age = relativeTime(at, now);
  return (
    // The server's clock and the browser's differ by the render delay, which
    // can tip "59m" into "1h": not a real mismatch.
    <time dateTime={at} title={WHEN.format(new Date(at))} suppressHydrationWarning>
      {age === "now" ? "just now" : `${age} ago`}
    </time>
  );
}

const RUN_STATUS: Record<AutomationRun["status"], { label: string; text: string; dot: string }> = {
  started: { label: "Starting", text: "text-muted-foreground", dot: "bg-muted-foreground" },
  ready: { label: "Running", text: "text-positive", dot: "bg-positive" },
  failed: { label: "Failed", text: "text-destructive", dot: "bg-destructive" },
  refused: { label: "Didn't start", text: "text-warning", dot: "bg-warning" },
};

/** A run's status as a dot and its word, or `label` in its place. */
function RunStatus({ status, label = RUN_STATUS[status].label }: { status: AutomationRun["status"]; label?: string }) {
  const { text, dot } = RUN_STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5", text)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      {label}
    </span>
  );
}

/** The org's automations: name, triggers, repositories, how its last run went,
 *  on or off (an admin switches it here), and who it runs as. */
function AutomationList({
  orgId,
  automations,
  runs,
  now,
  admin,
  byConnector,
}: {
  orgId: string;
  automations: Automation[] | null;
  runs: AutomationRun[] | null;
  now: number;
  admin: boolean;
  /** A team org's: they run as its connector, not a member. */
  byConnector: boolean;
}) {
  const router = useRouter();
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Each automation's newest run among those loaded (newest first). The page
  // loads the org's latest runs, not every automation's: one with none among
  // them shows a dash rather than claiming it never ran.
  const lastRun = new Map<string, AutomationRun>();
  for (const run of runs ?? []) if (!lastRun.has(run.automationId)) lastRun.set(run.automationId, run);

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
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-3 py-8 text-center">
          <span className="grid size-8 place-items-center rounded-md bg-muted text-muted-foreground">
            <GitPullRequest className="size-4" />
          </span>
          <div className="text-[13px] font-medium text-foreground">No automations yet</div>
          <p className="text-xs text-muted-foreground">
            {admin
              ? "Start one from a template below, or from scratch."
              : "An admin of this org can set one up, like a code review on every pull request."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full text-[13px]">
            <thead className="bg-muted/30 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">Name</th>
                <th className="px-3 py-2 font-normal">Trigger</th>
                <th className="px-3 py-2 font-normal">Repositories</th>
                <th className="px-3 py-2 font-normal">Last run</th>
                <th className="px-3 py-2 font-normal">Enabled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {automations.map((automation) => {
                const last = lastRun.get(automation.id);
                const runsAs = byConnector ? CONNECTOR_NAME : automation.runsAs?.login ? `@${automation.runsAs.login}` : null;
                return (
                  <tr key={automation.id} className="transition-colors hover:bg-muted/20">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                          <GitPullRequest className="size-3.5" />
                        </span>
                        <div className="min-w-0">
                          <Link href={`/automations/${automation.id}`} className="text-foreground hover:underline">
                            {automation.name}
                          </Link>
                          <div className="text-xs text-muted-foreground">
                            {runsAs ? `Runs as ${runsAs} · ` : ""}Created {DATE.format(new Date(automation.createdAt))}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <TriggerChips triggers={automation.triggers} />
                    </td>
                    <td className="px-3 py-2.5 text-foreground/75">
                      {automation.repos.length === 0
                        ? "None"
                        : `${automation.repos[0].fullName}${automation.repos.length > 1 ? ` +${automation.repos.length - 1}` : ""}`}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs">
                      {last ? (
                        <div className="space-y-0.5">
                          {/* "Running" for a run from days ago would read as still going: here,
                              a run that got going says when it started. */}
                          <RunStatus status={last.status} label={last.status === "ready" ? "Started" : undefined} />
                          <div className="text-muted-foreground">
                            <Ago at={last.createdAt} now={now} />
                          </div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}
    </section>
  );
}

type RunFilter = "all" | AutomationRun["status"];

/** The org's latest runs: which automation, on which pull request and
 *  commit, how it went, and the session it started; narrowed by status. */
function RecentRuns({
  orgId,
  runs,
  now,
  admin,
  byConnector,
}: {
  orgId: string;
  runs: AutomationRun[] | null;
  now: number;
  admin: boolean;
  byConnector: boolean;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<RunFilter>("all");
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

  // A filter for each status there is a run in, in the table's order of
  // concern; "All" always. One left pointing at a status that has since gone
  // (after a refresh) falls back to all.
  const all = runs ?? [];
  const counts = new Map<RunFilter, number>([["all", all.length]]);
  for (const run of all) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  const filters = (["all", "ready", "started", "failed", "refused"] as const).filter((f) => counts.has(f));
  const shown = counts.has(filter) ? filter : "all";
  const visible = shown === "all" ? all : all.filter((run) => run.status === shown);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}
      {runs === null ? (
        <p className="text-[13px] text-muted-foreground">Couldn&apos;t load the runs. Reload the page to try again.</p>
      ) : runs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-[13px] text-muted-foreground">
          No runs yet. One starts when a pull request on an automation&apos;s repository is opened or gets new commits.
        </p>
      ) : (
        <>
          {/* "All" and at least two statuses: with one, a pill would only
              repeat what every row says. */}
          {filters.length > 2 ? (
            <div role="group" aria-label="Filter runs by status" className="flex flex-wrap gap-1.5">
              {filters.map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={shown === f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                    shown === f
                      ? "border-border bg-accent text-foreground"
                      : "border-border/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f === "all" ? "All" : RUN_STATUS[f].label}
                  <span className="tabular-nums text-muted-foreground">{counts.get(f)}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="min-h-0 overflow-auto rounded-lg border border-border/60">
            <table className="w-full text-[13px]">
              {/* Pinned while the runs scroll under it: opaque, so they don't
                  show through. */}
              <thead className="sticky top-0 z-10 bg-background text-left text-xs text-muted-foreground shadow-[0_1px_0_var(--border)]">
                <tr className="bg-muted/30">
                  <th className="px-3 py-2 font-normal">Pull request</th>
                  <th className="px-3 py-2 font-normal">Automation</th>
                  <th className="px-3 py-2 font-normal">Status</th>
                  <th className="px-3 py-2 font-normal">When</th>
                  <th className="px-3 py-2 font-normal">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {visible.map((run) => (
                  <tr key={run.id} className="align-top transition-colors hover:bg-muted/20">
                    <td className="px-3 py-2.5">
                      <a
                        href={`https://github.com/${run.repoFullName}/pull/${run.prNumber}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-foreground hover:underline"
                      >
                        {run.repoFullName}#{run.prNumber}
                      </a>
                      <div className="max-w-sm truncate text-xs text-muted-foreground">
                        {run.prTitle ? `${run.prTitle} · ` : ""}
                        <span className="font-mono">{run.headSha.slice(0, 7)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-foreground/75">{run.automationName}</td>
                    <td className="px-3 py-2.5">
                      <RunStatus status={run.status} />
                      {run.reason ? <div className="max-w-xs text-xs text-muted-foreground">{run.reason}</div> : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">
                      <Ago at={run.createdAt} now={now} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs">
                      <div className="flex justify-end gap-3">
                        {/* A connector's session is its own, not a member's to open:
                            its admins read it, read-only. */}
                        {run.workspaceId && !byConnector ? (
                          <Link
                            href={`/workspaces/${run.workspaceId}`}
                            className="text-muted-foreground hover:text-foreground hover:underline"
                          >
                            Open session
                          </Link>
                        ) : run.workspaceId && admin ? (
                          <Link
                            href={`/automations/runs/${run.id}`}
                            className="text-muted-foreground hover:text-foreground hover:underline"
                          >
                            View session
                          </Link>
                        ) : null}
                        {admin && (run.status === "failed" || run.status === "refused") ? (
                          <button
                            type="button"
                            onClick={() => void rerun(run)}
                            disabled={rerunning !== null}
                            className="text-muted-foreground hover:text-foreground hover:underline disabled:opacity-60"
                          >
                            {rerunning === run.id ? "Starting…" : "Run again"}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
