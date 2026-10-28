"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ConversationTimeline } from "@/components/conversation-timeline";
import { InlineMessage } from "@/components/ui/notice";
import { SkeletonRows, SkeletonSwap } from "@/components/ui/skeleton-swap";
import { CONNECTOR_NAME } from "@/lib/automations/connector-name";
import type { ReviewView } from "@/lib/automations/review-view";
import type { AutomationRun } from "@/lib/db/automation-runs";
import { AgentEvent } from "@/lib/runtime/agent-protocol";
import { appendEvent } from "@/lib/runtime/conversation-events";
import { reconnectPlan } from "@/lib/runtime/reconnect";

const WHEN = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

/**
 * A run's review session, read-only, for the org's admins: its conversation
 * as it happens while its box is up, else as its latest snapshot kept it.
 * Nothing here reaches the box: the server reads the conversation and passes
 * on only that, so there's no prompt to send, terminal or files.
 */
export function ReviewSessionView({ orgId, run }: { orgId: string; run: AutomationRun }) {
  const base = `/api/orgs/${orgId}/automations/runs/${run.id}/conversation`;
  const [view, setView] = useState<ReviewView | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Asked again when a live stream ends: its box paused, it was archived, or
  // the stream dropped (after a backoff).
  const [generation, setGeneration] = useState(0);
  const seen = useRef(new Set<string>());
  // Where the live stream is up to: its last resumable event's id (a byte
  // offset; a state event's "0" is none), kept here rather than by
  // EventSource, which would resume from "0" and read it all again.
  const cursor = useRef<string | null>(null);
  const attempt = useRef(0);

  useEffect(() => {
    let active = true;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      attempt.current += 1;
      const plan = reconnectPlan(attempt.current);
      if (!plan.retry) {
        setError("Lost the review session's conversation.");
        return;
      }
      retry = setTimeout(() => {
        if (active) setGeneration((g) => g + 1);
      }, plan.delayMs);
    };
    void (async () => {
      try {
        const res = await fetch(base, { cache: "no-store" });
        const body = (await res.json()) as ReviewView & { error?: string };
        if (!active) return;
        if (!res.ok) throw new Error(body.error ?? "Couldn't read the review session.");
        setView(body);
        setError(null);
        if (body.mode === "archived") {
          cursor.current = null;
          seen.current = new Set();
          setEvents(body.events);
          return;
        }
        // Paused: what was read live stays on screen.
        if (body.mode !== "live") return;
        source = new EventSource(`${base}/stream${cursor.current ? `?lastEventId=${cursor.current}` : ""}`);
        source.onmessage = (message) => {
          let parsed;
          try {
            parsed = AgentEvent.safeParse(JSON.parse(message.data));
          } catch {
            return;
          }
          if (!parsed.success) return;
          const event = parsed.data;
          // Healthy once it moves on: not on opening, nor on the state event
          // every fresh connect sends, so a stream that drops straight after
          // keeps backing off.
          if (message.lastEventId && message.lastEventId !== "0") {
            cursor.current = message.lastEventId;
            attempt.current = 0;
          }
          setEvents((prev) => appendEvent(prev, event, message.lastEventId, seen.current));
        };
        // Reconnected here, not by EventSource: from the kept cursor, after a
        // backoff, and looking again at whether it's still live.
        source.onerror = () => {
          source?.close();
          if (active) again();
        };
      } catch (cause) {
        if (!active) return;
        // Mid-reconnect, a failed look is one more attempt, not the end.
        if (attempt.current > 0) again();
        else setError(cause instanceof Error ? cause.message : "Couldn't read the review session.");
      }
    })();
    return () => {
      active = false;
      clearTimeout(retry);
      source?.close();
    };
  }, [base, generation]);

  const tryAgain = () => {
    attempt.current = 0;
    setError(null);
    setGeneration((g) => g + 1);
  };

  const pr = `${run.repoFullName}#${run.prNumber}`;
  const state =
    view === null
      ? null
      : view.mode === "live"
        ? "Live"
        : view.mode === "archived"
          ? `Archived ${WHEN.format(new Date(view.archivedAt))}`
          : "Paused";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-1 border-b border-border/60 px-4 py-3">
        <Link
          href="/automations"
          className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Automations
        </Link>
        <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
          <span className="font-medium text-foreground">{run.automationName}</span>
          <a
            href={`https://github.com/${run.repoFullName}/pull/${run.prNumber}`}
            target="_blank"
            rel="noreferrer"
            className="text-foreground/80 hover:underline"
          >
            {pr}
            {run.prTitle ? `: ${run.prTitle}` : ""}
          </a>
          <span className="font-mono text-xs text-muted-foreground">{run.headSha.slice(0, 7)}</span>
          {state ? <span className={view?.mode === "live" ? "text-xs text-positive" : "text-xs text-muted-foreground"}>{state}</span> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {CONNECTOR_NAME}&apos;s review session, read-only. What it posted is on the pull request.
        </p>
      </div>
      {error ? (
        <div className="p-4">
          <InlineMessage actions={[{ label: "Try again", onClick: tryAgain }]}>{error}</InlineMessage>
        </div>
      ) : null}
      {view?.mode === "none" ? (
        <p className="px-4 pt-3 text-[13px] text-muted-foreground">
          {events.length > 0 ? "Its box has paused: this is the conversation as far as it was read. " : "Its box is paused and it hasn't been archived, so there's nothing to read here yet. "}
          It&apos;s archived when the pull request gets new commits or closes.
        </p>
      ) : null}
      {view?.mode === "none" && events.length === 0 ? null : (
        <SkeletonSwap
          ready={view !== null}
          skeleton={<SkeletonRows rows={6} rowHeight={28} indent={16} className="px-4 pt-4" />}
          label="Conversation"
          className="min-h-0 flex-1"
        >
          <div className="flex h-full min-h-0 flex-col">
            <ConversationTimeline events={events} />
          </div>
        </SkeletonSwap>
      )}
    </div>
  );
}
