"use client";

import { ArrowRight, Github, GitPullRequest, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { PageHeader, PageLayout } from "@/components/page-layout";
import { SettingsTabs } from "@/components/settings-tabs";
import { buttonVariants } from "@/components/ui/button";
import { InlineMessage } from "@/components/ui/notice";
import { useNow } from "@/hooks/use-now";
import {
  type Automation,
  type AutomationTrigger,
  TRIGGER_KIND_LABELS,
  TRIGGER_KINDS,
  TRIGGER_LABELS,
  triggerKind,
  type TriggerKind,
} from "@/lib/automations/rules";
import { CONNECTOR_NAME } from "@/lib/automations/connector-name";
import { runSubject } from "@/lib/automations/run-label";
import { describeSchedule, type Schedule } from "@/lib/automations/schedule";
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
  runKind,
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
  /** The kind of trigger the runs are narrowed to (`?trigger=`); null, all. */
  runKind: TriggerKind | null;
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
  // Narrowed to a trigger's runs: that's what's being looked at.
  const [picked, setPicked] = useState<Tab>(runKind ? "runs" : (tabs[0] ?? "templates"));
  // The tab picked may be gone after a refresh (the last automation deleted).
  const active = tabs.includes(picked) ? picked : tabs[0];
  const count: Record<Tab, string | null> = {
    templates: templates.length ? String(templates.length) : null,
    // A full page of runs isn't all of them: "50+", not a total.
    runs: runs?.length ? `${runs.length}${runs.length >= runsLimit ? "+" : ""}` : null,
  };

  // Long automation lists stay bounded; the page can scroll on short screens.
  return (
    <PageLayout className="flex min-h-full flex-col gap-8">
      <PageHeader
        title="Automations"
        description={`Recurring and event-driven workflows for ${org.personal ? "your projects" : org.name}.`}
        actions={admin ? (
          <Link href="/automations/new" className={cn(buttonVariants({ size: "sm" }), "shrink-0")}>
            <Plus /> Create automation
          </Link>
        ) : null}
      />

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
              <RecentRuns
                orgId={org.id}
                runs={runs}
                kind={runKind}
                // The kinds its automations have, and the one narrowed to
                // (a bookmark's, after its last automation went), so its
                // pill shows which.
                kinds={TRIGGER_KINDS.filter(
                  (k) => k === runKind || automations?.some((a) => a.triggers.some((t) => triggerKind(t) === k)),
                )}
                now={now}
                admin={admin}
                byConnector={!org.personal}
              />
            )}
          </div>
        </section>
      ) : null}
    </PageLayout>
  );
}

type Tab = "templates" | "runs";

const TAB_LABELS: Record<Tab, string> = { templates: "Templates", runs: "Recent runs" };

/** A trigger as a chip, the same in the automations' rows and on templates;
 *  a schedule's says when (its first, and how many more). */
function TriggerChips({ triggers, schedules = [] }: { triggers: AutomationTrigger[]; schedules?: Schedule[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {triggers.map((trigger) => (
        <span key={trigger} className="rounded-md bg-muted/70 px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {trigger === "schedule" && schedules.length > 0
            ? `${describeSchedule(schedules[0])}${schedules.length > 1 ? ` +${schedules.length - 1}` : ""}`
            : TRIGGER_LABELS[trigger]}
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
          className="flex min-h-44 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-5 text-center transition-colors hover:border-border hover:bg-accent/40"
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
            className="group flex flex-col gap-4 rounded-xl border border-border/60 bg-card/30 p-5 transition-colors hover:border-border hover:bg-card/60"
          >
            <div className="flex items-center gap-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                <GitPullRequest className="size-4" />
              </span>
              <span className="text-xs text-muted-foreground">{template.category}</span>
            </div>
            <div className="flex-1 space-y-1">
              <div className="text-[13px] font-medium text-foreground">{template.name}</div>
              <div className="text-xs text-muted-foreground">{template.description}</div>
            </div>
            <div className="flex flex-wrap items-end justify-between gap-2">
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
    <div className={cn("flex items-start gap-3 text-xs", !installations?.length && "rounded-lg border border-warning/20 bg-warning/5 p-3")}>
      <Github className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <span className="text-foreground">GitHub connection</span>
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

/** A table header that stays put while its rows scroll under it: opaque, so
 *  they don't show through. Its row takes {@link HEAD_ROW}. */
const PINNED_HEAD =
  "sticky top-0 z-10 bg-background text-left text-xs text-muted-foreground shadow-[0_1px_0_var(--border)]";
const HEAD_ROW = "bg-muted/30";

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
  queued: { label: "Waiting", text: "text-muted-foreground", dot: "bg-muted-foreground/50" },
  started: { label: "Starting", text: "text-muted-foreground", dot: "bg-muted-foreground" },
  ready: { label: "Running", text: "text-positive", dot: "bg-positive" },
  failed: { label: "Failed", text: "text-destructive", dot: "bg-destructive" },
  refused: { label: "Didn't start", text: "text-warning", dot: "bg-warning" },
  skipped: { label: "Skipped", text: "text-muted-foreground", dot: "bg-muted-foreground/50" },
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
        <ul className="max-h-[40vh] divide-y divide-border/60 overflow-auto rounded-xl border border-border/60 bg-card/20">
          {automations.map((automation) => {
            const last = lastRun.get(automation.id);
            const runsAs = byConnector ? CONNECTOR_NAME : automation.runsAs?.login ? `@${automation.runsAs.login}` : null;
            return (
              <li key={automation.id} className="flex flex-wrap items-center gap-4 px-4 py-4">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <GitPullRequest className="size-4" />
                </span>
                <div className="min-w-0 flex-1 basis-48 space-y-1.5">
                  <Link href={`/automations/${automation.id}`} title={`Created ${DATE.format(new Date(automation.createdAt))}`} className="block truncate text-[13px] font-medium text-foreground hover:underline">
                    {automation.name}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">
                    {automation.repos.length ? `${automation.repos[0].fullName}${automation.repos.length > 1 ? ` +${automation.repos.length - 1}` : ""}` : "No repositories"}
                    {runsAs && ` · ${runsAs}`}
                  </p>
                  <TriggerChips triggers={automation.triggers} schedules={automation.schedules} />
                </div>
                {last && (
                  <div className="space-y-1 text-xs sm:text-right">
                    <RunStatus status={last.status} label={last.status === "ready" ? "Started" : undefined} />
                    <div className="text-muted-foreground"><Ago at={last.createdAt} now={now} /></div>
                  </div>
                )}
                <div className="ml-auto min-w-20 space-y-1 text-right">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={automation.enabled}
                    aria-label={`${automation.name}: ${automation.enabled ? "enabled" : "disabled"}`}
                    disabled={!admin || switching !== null}
                    onClick={() => void setEnabled(automation)}
                    className="inline-flex items-center gap-2 rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
                  >
                    <span aria-hidden className={cn("relative h-4 w-7 rounded-full transition-colors", automation.enabled ? "bg-primary" : "bg-muted-foreground/30")}>
                      <span className={cn("absolute top-0.5 size-3 rounded-full bg-background transition-[left]", automation.enabled ? "left-3.5" : "left-0.5")} />
                    </span>
                    <span className="hidden sm:inline">{automation.enabled ? "Enabled" : automation.archived ? "Archived" : "Disabled"}</span>
                  </button>
                  {automation.maxRuns !== null && (
                    <div className="text-xs text-muted-foreground">
                      {(automation.runsUsed ?? 0) >= automation.maxRuns
                        ? `Done: ran ${automation.maxRuns === 1 ? "once" : `${automation.maxRuns} times`}`
                        : `${automation.runsUsed ?? 0} of ${automation.maxRuns} runs`}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}
    </section>
  );
}

type RunFilter = "all" | AutomationRun["status"];

/** The org's latest runs: which automation, what started it (a pull request
 *  and its commit, a schedule's time), how it went, and the session it
 *  started; narrowed by trigger and by status. */
export function RecentRuns({
  orgId,
  runs,
  kind,
  kinds,
  now,
  admin,
  byConnector,
}: {
  orgId: string;
  runs: AutomationRun[] | null;
  /** The kind of trigger they're narrowed to; null, all. */
  kind: TriggerKind | null;
  /** The kinds the org's automations have, to narrow to. */
  kinds: TriggerKind[];
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

  // A filter for each kind of trigger the org's automations have, read from
  // the database (the page's `?trigger=`), so a rare one's runs aren't lost
  // behind the latest; and within it, one for each status there is a run in,
  // in the table's order of concern. "All" always. A status left pointing at
  // one that has since gone (after a refresh) falls back to all.
  const narrow = (k: TriggerKind | null) =>
    router.replace(k ? `/automations?trigger=${k}` : "/automations", { scroll: false });
  const all = runs ?? [];
  const counts = new Map<RunFilter, number>([["all", all.length]]);
  for (const run of all) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  const filters = (["all", "queued", "ready", "started", "failed", "refused"] as const).filter((f) => counts.has(f));
  const shown = counts.has(filter) ? filter : "all";
  const visible = shown === "all" ? all : all.filter((run) => run.status === shown);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}
      {/* "All" and at least two kinds: with one, a pill would only repeat
          what every row says. */}
      {kinds.length > 1 || kind ? (
        <div role="group" aria-label="Filter runs by trigger" className="flex flex-wrap gap-1.5">
          {([null, ...kinds] as (TriggerKind | null)[]).map((k) => (
            <button
              key={k ?? "all"}
              type="button"
              aria-pressed={kind === k}
              onClick={() => narrow(k)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                kind === k ? "border-border bg-accent text-foreground" : "border-border/60 text-muted-foreground hover:text-foreground",
              )}
            >
              {k ? TRIGGER_KIND_LABELS[k] : "All triggers"}
            </button>
          ))}
        </div>
      ) : null}
      {runs === null ? (
        <p className="text-[13px] text-muted-foreground">Couldn&apos;t load the runs. Reload the page to try again.</p>
      ) : runs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-[13px] text-muted-foreground">
          {kind
            ? "No runs of this trigger yet."
            : "No runs yet. One starts when an automation's trigger fires: a pull request or issue event, a schedule come due, or a POST to its webhook."}
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
              <thead className={PINNED_HEAD}>
                <tr className={HEAD_ROW}>
                  <th className="px-3 py-2 font-normal">Run on</th>
                  <th className="px-3 py-2 font-normal">Automation</th>
                  <th className="px-3 py-2 font-normal">Status</th>
                  <th className="px-3 py-2 font-normal">When</th>
                  <th className="px-3 py-2 font-normal">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {visible.map((run) => {
                  const subject = runSubject(run);
                  return (
                    <tr key={run.id} className="align-top transition-colors hover:bg-muted/20">
                      <td className="px-3 py-2.5">
                        <a
                          href={subject.href ?? undefined}
                          target="_blank"
                          rel="noreferrer"
                          className="text-foreground hover:underline"
                        >
                          {subject.title}
                        </a>
                        <div className="max-w-sm truncate text-xs text-muted-foreground">
                          {subject.detail}
                          {subject.detail && subject.commit ? " · " : ""}
                          {subject.commit ? <span className="font-mono">{subject.commit}</span> : null}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-foreground/75">
                        {run.automationName}
                        {run.trigger ? <div className="text-xs text-muted-foreground">{TRIGGER_LABELS[run.trigger]}</div> : null}
                      </td>
                      <td className="px-3 py-2.5">
                        <RunStatus status={run.status} />
                        {run.reason ? <div className="max-w-xs text-xs text-muted-foreground">{run.reason}</div> : null}
                        {run.status === "queued" && run.notBefore ? (
                          <div className="max-w-xs text-xs text-muted-foreground">
                            Starts {WHEN.format(new Date(run.notBefore))} unless another trigger comes
                          </div>
                        ) : null}
                        {run.combined > 1 ? <div className="text-xs text-muted-foreground">{run.combined} triggers combined</div> : null}
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
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
