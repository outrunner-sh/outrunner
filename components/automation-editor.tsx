"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/ui/loading-button";
import { InlineMessage } from "@/components/ui/notice";
import { Textarea } from "@/components/ui/textarea";
import {
  type AppCoverage,
  AUTOMATION_TRIGGERS,
  type AutomationRepo,
  type AutomationTrigger,
  NAME_MAX,
  PROMPT_MAX,
  TRIGGER_LABELS,
} from "@/lib/automations/rules";
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
  projectIds: string[];
  enabled: boolean;
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
 * triggers, repositories and prompt, on or off. Only an admin edits; a member
 * sees it read-only. A repository the GitHub App can't act on is flagged,
 * since the automation can't post there.
 */
export function AutomationEditor({
  orgId,
  draft,
  repos,
  coverage,
  editable,
}: {
  orgId: string;
  draft: AutomationDraft;
  repos: AutomationRepo[];
  /** The app's coverage by `owner/name`; empty when the app isn't set up. */
  coverage: Record<string, AppCoverage>;
  editable: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(draft.name);
  const [prompt, setPrompt] = useState(draft.prompt);
  const [triggers, setTriggers] = useState<AutomationTrigger[]>(draft.triggers);
  const [projectIds, setProjectIds] = useState<string[]>(draft.projectIds);
  const [enabled, setEnabled] = useState(draft.enabled);
  const [filter, setFilter] = useState("");
  const canPost = (repo: AutomationRepo) => !COVERAGE_NOTES[coverage[repo.fullName] ?? "installed"];
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

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      // A change sends only what changed: changing what it does (prompt,
      // triggers, repositories) makes it run as you, renaming doesn't.
      const same = (a: string[], b: string[]) => a.length === b.length && a.every((v) => b.includes(v));
      const body = creating
        ? { name, template: draft.template, prompt, triggers, projectIds, enabled }
        : {
            ...(name !== draft.name ? { name } : {}),
            // The server keeps it trimmed.
            ...(prompt.trim() !== draft.prompt ? { prompt } : {}),
            ...(same(triggers, draft.triggers) ? {} : { triggers }),
            // With no runner, Save takes it on: sending its repositories is
            // what does (update_automation), unchanged as they may be.
            ...(same(projectIds, draft.projectIds) && draft.runsAs !== null ? {} : { projectIds }),
            ...(enabled !== draft.enabled ? { enabled } : {}),
          };
      await requestJson(creating ? `/api/orgs/${orgId}/automations` : `/api/orgs/${orgId}/automations/${draft.id}`, {
        method: creating ? "POST" : "PATCH",
        body,
        fallback: "Couldn't save the automation. Try again.",
      });
      router.push("/automations");
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
            {creating
              ? "Runs as you, on Outrunner's models and your allowance of them, and posts as the Outrunner GitHub App."
              : `${
                  draft.runsAs === null
                    ? `Runs as no one: whoever last changed it is no longer in the org${editable ? ". Save it to run it as you" : ""}`
                    : draft.runsAs === ""
                      ? "Runs as whoever last changed what it does"
                      : `Runs as @${draft.runsAs}`
                }, and posts as the Outrunner GitHub App.${
                  editable
                    ? " Changing its prompt, triggers or repositories makes it run as you, on your allowance of Outrunner's models."
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
            {AUTOMATION_TRIGGERS.map((trigger) => (
              <Check
                key={trigger}
                checked={triggers.includes(trigger)}
                disabled={!editable}
                onChange={() => setTriggers(toggle(triggers, trigger))}
              >
                {TRIGGER_LABELS[trigger]}
              </Check>
            ))}
          </div>
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
                  {filter ? "No repositories the GitHub App can post on match." : "The GitHub App can't post on any of this org's repositories yet. Install it in Settings → Org → GitHub."}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {reviewable.map((repo) => repoCheck(repo, canPost(repo) ? null : COVERAGE_NOTES[coverage[repo.fullName] ?? "installed"]))}
                </div>
              )}
            </div>
          )}
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
            The session also gets the pull request it&apos;s for: its repository, number, and base and head branches.
          </p>
        </Field>

        <Field label="Status">
          <Check checked={enabled} disabled={!editable} onChange={() => setEnabled(!enabled)}>
            Enabled
          </Check>
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
