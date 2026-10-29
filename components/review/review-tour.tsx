"use client";

import { ArrowLeft, ArrowRight, Compass, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import type { Tour } from "@/lib/review/tour";

type TourState =
  | { status: "off" }
  | { status: "loading" }
  | { status: "failed"; error: string }
  /** `step` -1 is the overview, before the first hunk. */
  | { status: "on"; tour: Tour; step: number };

/** Whether a key press is someone typing, which the tour's keys leave be. */
function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName));
}

/**
 * The guided tour's state: written on asking (POST /api/review/tour), then
 * stepped through with Next and Back (or → and ←; Esc ends it). `focus` is
 * the hunk the current step is on, for the diff to scroll to and highlight.
 */
export function useTour(repo: string, number: number, headSha: string) {
  const router = useRouter();
  const [state, setState] = useState<TourState>({ status: "off" });
  // A tour written for an older head is redone: its hunks are not the page's.
  const [tourFor, setTourFor] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (state.status === "on" && tourFor === headSha) {
      setState({ ...state, step: -1 });
      return;
    }
    setState({ status: "loading" });
    try {
      const response = await fetch("/api/review/tour", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, number }),
      });
      const body = (await response.json().catch(() => ({}))) as { tour?: Tour; headSha?: string; error?: string };
      if (!response.ok || !body.tour) throw new Error(body.error ?? "Couldn't write the tour.");
      // New commits since the page loaded: show them, so the tour's hunks
      // are the ones on the page.
      if (body.headSha && body.headSha !== headSha) router.refresh();
      setTourFor(body.headSha ?? headSha);
      setState({ status: "on", tour: body.tour, step: -1 });
    } catch (error) {
      setState({ status: "failed", error: error instanceof Error ? error.message : "Couldn't write the tour." });
    }
  }, [headSha, number, repo, router, state, tourFor]);

  const end = useCallback(() => setState({ status: "off" }), []);
  const go = useCallback(
    (delta: number) =>
      setState((current) =>
        current.status === "on"
          ? { ...current, step: Math.max(-1, Math.min(current.tour.steps.length - 1, current.step + delta)) }
          : current,
      ),
    [],
  );

  const on = state.status === "on";
  useEffect(() => {
    if (!on) return;
    const onKey = (event: KeyboardEvent) => {
      if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowRight") go(1);
      else if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "Escape") end();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on, go, end]);

  const focus = state.status === "on" && state.step >= 0 ? (state.tour.steps[state.step]?.hunkId ?? null) : null;
  return { state, start, end, next: () => go(1), back: () => go(-1), focus };
}

export type TourControls = ReturnType<typeof useTour>;

export function StartTourButton({ tour }: { tour: TourControls }) {
  const loading = tour.state.status === "loading";
  return (
    <Button size="sm" variant="outline" onClick={() => void tour.start()} disabled={loading} title="Walk through the diff, step by step">
      <Compass />
      {loading ? "Reading the diff…" : tour.state.status === "on" ? "Restart tour" : "Start tour"}
    </Button>
  );
}

/**
 * The tour's card, kept in view at the top of the page as the diff scrolls:
 * the overview first, then each step's file, title and explanation, with
 * Back and Next.
 */
export function TourCard({ tour }: { tour: TourControls }) {
  const { state } = tour;
  if (state.status === "failed") {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-[12px] text-destructive">
        {state.error}
        <button type="button" onClick={tour.end} aria-label="Dismiss">
          <X className="size-3.5" />
        </button>
      </div>
    );
  }
  if (state.status !== "on") return null;
  const { steps, summary, skipped, complete } = state.tour;
  const step = state.step >= 0 ? steps[state.step] : null;
  const last = state.step >= steps.length - 1;
  // Pinned at the very top of the PR page's column, over its top padding
  // (py-6), so no code shows above it as the diff scrolls under.
  return (
    <div className="sticky -top-6 z-10 -mx-1 rounded-lg border border-sky-500/40 bg-background/95 px-4 py-3 shadow-sm backdrop-blur">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Compass className="size-3.5 text-sky-500" />
          {step ? `Step ${state.step + 1} of ${steps.length}` : "Tour"}
          {step && <span className="truncate font-mono">· {step.path}</span>}
        </span>
        <button type="button" onClick={tour.end} className="hover:text-foreground" aria-label="End tour" title="End tour (Esc)">
          <X className="size-3.5" />
        </button>
      </div>
      <div className="mt-1.5 max-h-48 overflow-y-auto text-[13px]">
        {step ? (
          <>
            {step.title && <p className="font-medium text-foreground">{step.title}</p>}
            {step.explanation ? <Markdown>{step.explanation}</Markdown> : <p className="text-muted-foreground">No notes for this part.</p>}
          </>
        ) : steps.length === 0 ? (
          <p className="text-muted-foreground">Nothing to walk through: this PR changes only generated files, or ones without a diff.</p>
        ) : (
          <>
            {summary ? <Markdown>{summary}</Markdown> : null}
            <p className="mt-1 text-[12px] text-muted-foreground">
              {steps.length} {steps.length === 1 ? "step" : "steps"} through {new Set(steps.map((s) => s.path)).size} files.
              {skipped.length > 0 && ` Left out: ${skipped.length} generated or binary ${skipped.length === 1 ? "file" : "files"}.`}
              {!complete && " It covers only the files GitHub listed, not the whole PR."}
            </p>
          </>
        )}
      </div>
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={tour.back} disabled={state.step < 0} title="Back (←)">
          <ArrowLeft />
          Back
        </Button>
        {last ? (
          <Button size="sm" onClick={tour.end}>
            Done
          </Button>
        ) : (
          <Button size="sm" onClick={tour.next} title="Next (→)">
            {state.step < 0 ? "Begin" : "Next"}
            <ArrowRight />
          </Button>
        )}
      </div>
    </div>
  );
}
