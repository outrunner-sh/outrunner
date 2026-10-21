"use client";

import { useState } from "react";
import { ArrowLeft, ChevronRight, Loader2 } from "lucide-react";

import { ImportSourceIcon } from "@/components/brand-icons";
import { Button } from "@/components/ui/button";
import {
  IMPORT_STATE_LABELS,
  IMPORT_UPLOAD_NOTE,
  type ImportProgress,
  importSummary,
  sessionFacts,
  withoutUnstarted,
} from "@/lib/imports/client";
import { relativeTime } from "@/lib/nav/sidebar";
import { type ImportProject, projectSources, shownSessions } from "@/lib/onboarding/import-projects";
import type { OnboardingEnv } from "@/lib/onboarding/types";
import { IMPORT_SOURCE_LABELS, type ScannedSession } from "@/lib/runtime/import-scan";
import { cn } from "@/lib/utils";

/**
 * Bringing projects over from this Mac: the repositories its Conductor, Claude
 * Code and Codex sessions work in (lib/onboarding/import-projects.ts). Picking
 * a project picks its active sessions; opening it picks them one by one. Each
 * comes over as a cloud session to resume, its repository connected as a
 * project. Nothing is picked until the user does: every session uploads its
 * whole conversation.
 */
export function ImportStep({
  env,
  projects,
  now,
  onBack,
  onNext,
  onImporting,
  disabled,
}: {
  env: OnboardingEnv;
  /** What the Mac's scan offers (lib/onboarding/import-projects.ts); undefined while it runs. */
  projects: ImportProject[] | undefined;
  /** The time "active" is measured from. */
  now: number;
  onBack: () => void;
  onNext: () => void;
  /** An import started or ended: onboarding mustn't be left mid-upload. */
  onImporting: (importing: boolean) => void;
  /** Onboarding is leaving: nothing to start meanwhile. */
  disabled: boolean;
}) {
  const [withOlder, setWithOlder] = useState(false);
  const [pickedKeys, setPicked] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Record<string, ImportProgress>>({});
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = (projects ?? [])
    .map((project) => ({ project, sessions: shownSessions(project, withOlder) }))
    .filter(({ sessions }) => sessions.length > 0);
  const olderCount = (projects ?? []).reduce((n, p) => n + p.older.length, 0);
  // Only what is on screen and not imported yet: hiding older sessions
  // unpicks them, and an imported one isn't imported twice.
  const pickable = shown.flatMap(({ sessions }) => sessions).filter((s) => progress[s.key]?.state !== "done");
  const picked = pickable.filter((s) => pickedKeys.has(s.key));
  const busy = importing || disabled;

  const setPicks = (sessions: ScannedSession[], on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      for (const s of sessions) {
        if (on) next.add(s.key);
        else next.delete(s.key);
      }
      return next;
    });

  const start = async () => {
    setImporting(true);
    onImporting(true);
    setError(null);
    try {
      await env.importSessions(picked, (p) => setProgress((current) => ({ ...current, [p.key]: p })));
      setPicked(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // The error is the only thing to say: without this the sessions it never
      // reached stay on "Waiting", under a project still reading "Importing…".
      setProgress(withoutUnstarted);
    } finally {
      setImporting(false);
      onImporting(false);
    }
  };

  const imported = Object.values(progress).some((p) => p.state === "done");

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Bring your projects</h1>
        <p className="text-muted-foreground text-sm">
          Pick the projects you&apos;re working on in Conductor, Claude Code or Codex. Their active sessions come
          along, ready to pick up in the cloud.
        </p>
      </div>

      {projects === undefined ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Looking for projects on this Mac…
        </p>
      ) : (
        <div className="space-y-2">
          <ul className="border-border/60 max-h-[50vh] overflow-y-auto rounded-xl border">
            {shown.map(({ project, sessions }) => (
              <ProjectRow
                key={project.repo}
                project={project}
                sessions={sessions}
                picked={pickedKeys}
                progress={progress}
                now={now}
                disabled={busy}
                onPick={setPicks}
              />
            ))}
            {shown.length === 0 && (
              <li className="text-muted-foreground px-4 py-3 text-sm">
                Nothing worked on in the last 30 days. Show older sessions to see the rest.
              </li>
            )}
          </ul>
          {olderCount > 0 && (
            <button
              type="button"
              onClick={() => setWithOlder((on) => !on)}
              disabled={busy}
              className="text-muted-foreground hover:text-foreground text-xs disabled:opacity-50"
            >
              {withOlder
                ? "Hide sessions older than 30 days"
                : `Show ${olderCount} older ${olderCount === 1 ? "session" : "sessions"}`}
            </button>
          )}
        </div>
      )}

      <p className="text-muted-foreground text-xs">{IMPORT_UPLOAD_NOTE}</p>
      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeft className="size-4" /> Back
        </Button>
        <div className="flex items-center gap-2">
          {picked.length > 0 && (
            <Button variant="ghost" onClick={onNext} disabled={busy}>
              Not now
            </Button>
          )}
          {picked.length > 0 ? (
            <Button onClick={() => void start()} disabled={busy}>
              {importing && <Loader2 className="size-4 animate-spin" />}
              Import {picked.length} {picked.length === 1 ? "session" : "sessions"}
            </Button>
          ) : (
            <Button onClick={onNext} disabled={busy}>
              {imported ? "Continue" : "Skip"}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function ProjectRow({
  project,
  sessions,
  picked,
  progress,
  now,
  disabled,
  onPick,
}: {
  project: ImportProject;
  /** Its sessions on screen. */
  sessions: ScannedSession[];
  picked: Set<string>;
  progress: Record<string, ImportProgress>;
  now: number;
  disabled: boolean;
  onPick: (sessions: ScannedSession[], on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const left = sessions.filter((s) => progress[s.key]?.state !== "done");
  const pickedHere = left.filter((s) => picked.has(s.key)).length;
  const all = left.length > 0 && pickedHere === left.length;
  const summary = importSummary(sessions.flatMap((s) => progress[s.key] ?? []));
  const sources = projectSources(sessions);
  const label = `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`;
  const latest = ago(sessions[0], now);

  return (
    <li className="border-border/60 border-b last:border-b-0">
      <div className="flex items-center gap-3 px-4 py-3">
        <input
          type="checkbox"
          checked={all}
          ref={(el) => {
            if (el) el.indeterminate = pickedHere > 0 && !all;
          }}
          onChange={() => onPick(left, !all)}
          disabled={disabled || left.length === 0}
          aria-label={`Import ${project.repo}`}
          className="accent-foreground size-3.5"
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-sm">{project.repo}</span>
            <span className="text-muted-foreground block truncate text-xs">
              {summary || [label, latest && `last active ${latest}`].filter(Boolean).join(" · ")}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {sources.map((source) => (
              <span key={source} title={IMPORT_SOURCE_LABELS[source]} className="text-muted-foreground">
                <ImportSourceIcon source={source} className="size-3.5" />
              </span>
            ))}
          </span>
          <ChevronRight className={cn("text-muted-foreground size-4 shrink-0 transition-transform", open && "rotate-90")} />
        </button>
      </div>
      {open && (
        <ul className="border-border/60 divide-border/40 ml-10 divide-y border-t border-dashed">
          {sessions.map((s) => (
            <SessionRow
              key={s.key}
              session={s}
              picked={picked.has(s.key)}
              progress={progress[s.key]}
              now={now}
              disabled={disabled}
              onToggle={() => onPick([s], !picked.has(s.key))}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function SessionRow({
  session: s,
  picked,
  progress,
  now,
  disabled,
  onToggle,
}: {
  session: ScannedSession;
  picked: boolean;
  progress?: ImportProgress;
  now: number;
  disabled: boolean;
  onToggle: () => void;
}) {
  const when = ago(s, now);
  return (
    <li>
      <label className="flex cursor-pointer items-start gap-3 py-2.5 pr-4">
        <input
          type="checkbox"
          checked={picked || progress?.state === "done"}
          onChange={onToggle}
          disabled={disabled || progress?.state === "done"}
          className="accent-foreground mt-0.5 size-3.5"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span title={IMPORT_SOURCE_LABELS[s.source]} className="text-muted-foreground shrink-0">
              <ImportSourceIcon source={s.source} className="size-3.5" />
            </span>
            <span className="truncate text-sm">{s.title || s.sessionId}</span>
          </span>
          <span className="text-muted-foreground block truncate text-xs">
            {progress ? (
              <span className={progress.state === "failed" ? "text-foreground" : undefined}>
                {IMPORT_STATE_LABELS[progress.state]}
                {progress.message && ` · ${progress.message}`}
              </span>
            ) : (
              [s.branch, when, ...sessionFacts(s)].filter(Boolean).join(" · ")
            )}
          </span>
        </span>
      </label>
    </li>
  );
}

/** "2h ago", "just now", or "" when the scan has no time for it. */
function ago(s: ScannedSession, now: number): string {
  const age = relativeTime(s.updatedAt ?? s.startedAt, now);
  return age === "now" ? "just now" : age && `${age} ago`;
}
