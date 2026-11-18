"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AutomationWebhook } from "@/components/automation-webhook";
import { AutomationLimits, type Limits } from "@/components/automation-limits";
import { AutomationSchedules, type ScheduleForm, scheduleForm, scheduleOf, useLocalZone } from "@/components/automation-schedules";
import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { Textarea } from "@/components/ui/textarea";
import {
  type AppCoverage,
  type AutomationRepo,
  type AutomationTrigger,
  canCoverNewRepos,
  GITHUB_TRIGGERS,
  NAME_MAX,
  PROMPT_MAX,
  TRIGGER_LABELS,
} from "@/lib/automations/rules";
import type { Schedule } from "@/lib/automations/schedule";
import { CONNECTOR_NAME } from "@/lib/automations/connector-name";
import type { WebhookUrl } from "@/lib/db/automation-webhooks";
import { requestJson } from "@/lib/http/request-json";
import { cn } from "@/lib/utils";

/** What the editor opens with: an automation to change, or a new one's
 *  starting point (blank, or a template's). */
export type AutomationDraft = {
  id: string | null;
  name: string;
  template: string | null;
  prompt: string;
  triggers: AutomationTrigger[];
  schedules: Schedule[];
  projectIds: string[];
  /** Repositories connected to the org later join it. */
  coverNewRepos: boolean;
  enabled: boolean;
  /** Whose review requests, and which issue labels, start it. */
  reviewers: string[];
  labels: string[];
  limits: Limits;
  /** Done (it ran its count, or was archived): off until switched on. */
  archived: boolean;
  /** How many times it has run against its limit; null with none. */
  runsUsed: number | null;
  /** Who it runs as, for one that exists: their login, "" when it can't be
   *  told, null once they're no longer in the org. */
  runsAs: string | null;
};

const COVERAGE_NOTES: Record<AppCoverage, string | null> = {
  installed: null,
  not_installed: "The GitHub App isn't installed on this repository",
  suspended: "The GitHub App is suspended on this account",
  unknown: "Couldn't check the GitHub App on this repository",
};

/**
 * Make or change an automation of the org the app is showing: its name,
 * triggers (GitHub events, schedules), repositories and prompt, on or off.
 * Only an admin edits; a member sees it read-only. A repository the GitHub App can't act on is flagged,
 * since the automation can't post there.
 */
export function AutomationEditor({
  orgId,
  draft,
  repos,
  coverage,
  editable,
  byConnector,
  onHarness,
  webhook,
}: {
  orgId: string;
  draft: AutomationDraft;
  repos: AutomationRepo[];
  /** The app's coverage by `owner/name`; empty when the app isn't set up. */
  coverage: Record<string, AppCoverage>;
  editable: boolean;
  /** A team org's: it runs as the org's connector, not whoever saves it. */
  byConnector: boolean;
  /** The org's automations run on their runner's default model and coding
   *  agent, not Outrunner's models (Settings → Org). */
  onHarness: boolean;
  /** Its webhook's URL, for an admin; null for a member, or a new one. */
  webhook: WebhookUrl | null;
}) {
  const router = useRouter();
  const [name, setName] = useState(draft.name);
  const [prompt, setPrompt] = useState(draft.prompt);
  const [triggers, setTriggers] = useState<AutomationTrigger[]>(draft.triggers);
  const local = useLocalZone();
  const [schedules, setSchedules] = useState<ScheduleForm[]>(() => draft.schedules.map((s) => scheduleForm(s.timezone, s)));
  const scheduled = triggers.includes("schedule");
  // Ticking Schedule with none yet starts one, in the browser's zone.
  const toggleSchedule = () => {
    setTriggers(toggle(triggers, "schedule"));
    if (!scheduled && schedules.length === 0) setSchedules([scheduleForm(local)]);
  };
  const [reviewers, setReviewers] = useState(draft.reviewers.join(", "));
  const [labels, setLabels] = useState(draft.labels.join(", "));
  const [limits, setLimits] = useState<Limits>(draft.limits);
  const [projectIds, setProjectIds] = useState<string[]>(draft.projectIds);
  const [coverNewRepos, setCoverNewRepos] = useState(draft.coverNewRepos);
  // Off whenever a trigger runs on every repository (a schedule, a webhook),
  // and saved off: ticking one turns it off.
  const canCover = canCoverNewRepos(triggers);
  const covering = coverNewRepos && canCover;
  const [enabled, setEnabled] = useState(draft.enabled);
  const [filter, setFilter] = useState("");
  // Listed unless the App definitely can't post on it: "unknown" (its
  // installation's list couldn't be read, or was cut short) stays, flagged.
  const coverageOf = (repo: AutomationRepo) => coverage[repo.fullName] ?? "installed";
  const canPost = (repo: AutomationRepo) => coverageOf(repo) === "installed" || coverageOf(repo) === "unknown";
  const shown = repos.filter((r) => r.fullName.toLowerCase().includes(filter.trim().toLowerCase()));
  // Only those the app can post on, and any already picked that it can't any
  // more (so it can be unticked).
  const reviewable = shown.filter((r) => canPost(r) || projectIds.includes(r.projectId));
  const repoCheck = (repo: AutomationRepo, note: string | null) => (
    <Check
      key={repo.projectId}
      checked={projectIds.includes(repo.projectId)}
      disabled={!editable}
      onChange={() => setProjectIds(toggle(projectIds, repo.projectId))}
    >
      <span className="font-mono text-[12px]">{repo.fullName}</span>
      {note ? <span className="ml-2 text-xs text-warning">{note}</span> : null}
    </Check>
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creating = draft.id === null;

  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const triggerCheck = (trigger: AutomationTrigger) => (
    <Check key={trigger} checked={triggers.includes(trigger)} disabled={!editable} onChange={() => setTriggers(toggle(triggers, trigger))}>
      {TRIGGER_LABELS[trigger]}
    </Check>
  );

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      // A change sends only what changed: changing what it does (prompt,
      // triggers, schedules, repositories) makes it run as you, renaming
      // doesn't.
      const same = (a: string[], b: string[]) => a.length === b.length && a.every((v) => b.includes(v));
      const sent = scheduled ? schedules.map(scheduleOf) : [];
      // Schedules go with the triggers: either changed sends both.
      const before = draft.schedules.map((s) => scheduleOf(scheduleForm(s.timezone, s)));
      const timing = same(triggers, draft.triggers) && JSON.stringify(sent) === JSON.stringify(before) ? {} : { triggers, schedules: sent };
      // Typed as a list, comma or space between; the server checks each.
      const names = (text: string) => text.split(/[\s,]+/).filter(Boolean);
      const filters = {
        ...(JSON.stringify(names(reviewers)) !== JSON.stringify(draft.reviewers) ? { reviewers: names(reviewers) } : {}),
        ...(JSON.stringify(names(labels)) !== JSON.stringify(draft.labels) ? { labels: names(labels) } : {}),
      };
      const changedLimits = Object.fromEntries(
        (Object.keys(limits) as (keyof Limits)[]).filter((k) => limits[k] !== draft.limits[k]).map((k) => [k, limits[k]]),
      );
      const body = creating
        ? {
            name,
            template: draft.template,
            prompt,
            triggers,
            schedules: sent,
            reviewers: names(reviewers),
            labels: names(labels),
            ...limits,
            projectIds,
            coverNewRepos: covering,
            enabled,
          }
        : {
            ...filters,
            ...changedLimits,
            ...(name !== draft.name ? { name } : {}),
            // The server keeps it trimmed.
            ...(prompt.trim() !== draft.prompt ? { prompt } : {}),
            ...timing,
            // With no runner, Save takes it on: sending its repositories is
            // what does (update_automation), unchanged as they may be.
            // Sent with them too: one that covers new repositories isn't
            // held to the cap on them.
            ...(same(projectIds, draft.projectIds) && draft.runsAs !== null
              ? covering !== draft.coverNewRepos
                ? { coverNewRepos: covering }
                : {}
              : { projectIds, coverNewRepos: covering }),
            ...(enabled !== draft.enabled ? { enabled } : {}),
          };
      const { id } = await requestJson<{ id: string }>(
        creating ? `/api/orgs/${orgId}/automations` : `/api/orgs/${orgId}/automations/${draft.id}`,
        {
          method: creating ? "POST" : "PATCH",
          body,
          fallback: "Couldn't save the automation. Try again.",
        },
      );
      // Given a webhook it had none of: back to it, where its URL is now.
      router.push(triggers.includes("webhook") && !webhook?.path ? `/automations/${id}` : "/automations");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save the automation. Try again.");
      setSaving(false);
    }
  };

  const remove = async () => {
    if (deleting || creating) return;
    setDeleting(true);
    setError(null);
    try {
      await requestJson(`/api/orgs/${orgId}/automations/${draft.id}`, {
        method: "DELETE",
        fallback: "Couldn't delete the automation. Try again.",
      });
      router.push("/automations");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't delete the automation. Try again.");
      setDeleting(false);
    }
  };

  return (
    <div className="px-8 py-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <Link
          href="/automations"
          className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Automations
        </Link>
        <header className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">{creating ? "New automation" : draft.name}</h1>
          <p className="text-[13px] text-muted-foreground">
            {byConnector
              ? onHarness
                ? `Runs as ${CONNECTOR_NAME}, the org's own runner, on the org's default model and coding agent, and posts as the Outrunner GitHub App.`
                : `Runs as ${CONNECTOR_NAME}, the org's own runner on Outrunner's models (no member's account or allowance), and posts as the Outrunner GitHub App.`
              : creating
              ? onHarness
                ? "Runs as you, on your default model and coding agent, and posts as the Outrunner GitHub App."
                : "Runs as you, on Outrunner's models and your allowance of them, and posts as the Outrunner GitHub App."
              : `${
                  draft.runsAs === null
                    ? `Runs as no one: whoever last changed it is no longer in the org${editable ? ". Save it to run it as you" : ""}`
                    : draft.runsAs === ""
                      ? "Runs as whoever last changed what it does"
                      : `Runs as @${draft.runsAs}`
                }, and posts as the Outrunner GitHub App.${
                  editable
                    ? ` Changing its prompt, triggers or repositories makes it run as you, on ${onHarness ? "your default model and coding agent" : "your allowance of Outrunner's models"}.`
                    : ""
                }`}
          </p>
        </header>

        <Field label="Name" htmlFor="automation-name">
          <Input
            id="automation-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={NAME_MAX}
            disabled={!editable}
            autoComplete="off"
          />
        </Field>

        <Field label="Trigger">
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">Pull requests</div>
            {GITHUB_TRIGGERS.filter((t) => t.startsWith("pull_request.")).map((trigger) => triggerCheck(trigger))}
            {triggers.includes("pull_request.review_requested") ? (
              <div className="space-y-1 pl-5">
                <Input
                  value={reviewers}
                  onChange={(event) => setReviewers(event.target.value)}
                  disabled={!editable}
                  placeholder="octocat, acme/reviewers"
                  aria-label="Reviewers whose review requests start it"
                  className="h-7 max-w-sm font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">
                  A review requested of any of these starts it: GitHub logins, or teams as org/team. Requesting it again
                  runs it again.
                </p>
              </div>
            ) : null}
            <div className="pt-1.5 text-xs text-muted-foreground">Issues</div>
            {GITHUB_TRIGGERS.filter((t) => t.startsWith("issues.")).map((trigger) => triggerCheck(trigger))}
            {triggers.includes("issues.labeled") ? (
              <div className="space-y-1 pl-5">
                <Input
                  value={labels}
                  onChange={(event) => setLabels(event.target.value)}
                  disabled={!editable}
                  placeholder="Any label"
                  aria-label="Labels that start it"
                  className="h-7 max-w-sm text-xs"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  Only these labels, comma between; empty, any. A label that has spaces in it can&apos;t be named here yet. A
                  label another automation&apos;s run adds starts this one too, but a run never starts its own automation
                  again on the same issue within a day.
                </p>
              </div>
            ) : null}
            <div className="pt-1.5 text-xs text-muted-foreground">Outrunner</div>
            <Check checked={scheduled} disabled={!editable} onChange={toggleSchedule}>
              On a schedule
            </Check>
          </div>
          {scheduled ? (
            <div className="pt-1">
              <AutomationSchedules schedules={schedules} onChange={setSchedules} editable={editable} />
            </div>
          ) : null}
          <div className="pt-1.5">
            <Check checked={triggers.includes("webhook")} disabled={!editable} onChange={() => setTriggers(toggle(triggers, "webhook"))}>
              On a webhook
            </Check>
          </div>
          {triggers.includes("webhook") ? (
            <div className="pt-1">
              <AutomationWebhook orgId={orgId} automationId={draft.id} webhook={webhook} editable={editable} />
            </div>
          ) : null}
        </Field>

        <Field label="Repositories">
          {repos.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              This org has no repositories yet. Connect one from New Session first.
            </p>
          ) : (
            <div className="space-y-2">
              {repos.filter(canPost).length > 10 ? (
                <Input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter repositories"
                  aria-label="Filter repositories"
                  className="max-w-sm"
                />
              ) : null}
              {/* Only the ones the GitHub App can post on: an automation runs
                  on nothing else. */}
              {reviewable.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">
                  {filter.trim() ? (
                    "No repositories the GitHub App can post on match."
                  ) : (
                    <>
                      The GitHub App can&apos;t post on any of this org&apos;s repositories yet. Install it from{" "}
                      <Link href="/settings/org/integrations" className="underline underline-offset-2">
                        Settings → Organization → Integrations
                      </Link>
                      .
                    </>
                  )}
                </p>
              ) : (
                <div className="max-h-80 space-y-1.5 overflow-y-auto">
                  {reviewable.map((repo) => repoCheck(repo, COVERAGE_NOTES[coverageOf(repo)]))}
                </div>
              )}
            </div>
          )}
          <div className="space-y-1 pt-2">
            <Check checked={covering} disabled={!editable || !canCover} onChange={() => setCoverNewRepos(!coverNewRepos)}>
              Add new repositories automatically
            </Check>
            <p className="pl-5 text-xs text-muted-foreground">
              {canCover
                ? "Each repository connected to the org from now on is added here. Untick one to leave it out: it stays out."
                : "Only with GitHub triggers: a schedule or a webhook runs on every repository it has."}
            </p>
          </div>
        </Field>

        <Field label="Prompt" htmlFor="automation-prompt">
          <Textarea
            id="automation-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={PROMPT_MAX}
            disabled={!editable}
            className="max-h-[28rem] min-h-48 font-mono text-[12px] md:text-[12px]"
          />
          <p className="text-xs text-muted-foreground">
            The session is also told what started it: the pull request (its repository, number, and base and head
            branches) or issue, the schedule and the time it was due, or the webhook&apos;s payload. Put the payload where it
            belongs with <span className="font-mono">{"{{payload}}"}</span>, or one value of it with{" "}
            <span className="font-mono">{"{{payload.some.field}}"}</span>; with neither, it comes after the prompt. Anyone
            with the URL writes the payload, so the session is told to take it as data, not instructions.
          </p>
        </Field>

        <Field label="Runs">
          <AutomationLimits limits={limits} onChange={setLimits} editable={editable} runsUsed={draft.runsUsed} />
        </Field>

        <Field label="Status">
          <Check checked={enabled} disabled={!editable} onChange={() => setEnabled(!enabled)}>
            Enabled
          </Check>
          {draft.archived ? (
            <p className="text-xs text-muted-foreground">Archived: it&apos;s done. Switching it on brings it back.</p>
          ) : null}
        </Field>

        {error ? <InlineMessage actions={[{ label: "Dismiss", onClick: () => setError(null) }]}>{error}</InlineMessage> : null}

        {editable ? (
          <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
            <LoadingButton
              status={saving ? "pending" : "idle"}
              labels={{ idle: creating ? "Create automation" : "Save" }}
              disabled={deleting}
              onClick={() => void save()}
            />
            {creating ? null : (
              <HoldToConfirm
                label="Delete automation"
                onConfirm={() => void remove()}
                disabled={saving || deleting}
                className="h-7 px-2.5 text-xs"
              />
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Only the org&apos;s admins can change automations.</p>
        )}
      </div>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-[13px] text-muted-foreground">
          {label}
        </label>
      ) : (
        <div className="text-[13px] text-muted-foreground">{label}</div>
      )}
      {children}
    </div>
  );
}

function Check({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex items-center gap-2 text-[13px] text-foreground", disabled && "opacity-70")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="size-3.5 accent-[var(--primary)]"
      />
      <span className="min-w-0">{children}</span>
    </label>
  );
}
