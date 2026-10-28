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
  // Asked again when a live stream ends: its box paused, or it was archived.
  const [generation, setGeneration] = useState(0);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    let source: EventSource | null = null;
    void (async () => {
      try {
        const res = await fetch(base, { cache: "no-store" });
        const body = (await res.json()) as ReviewView & { error?: string };
        if (!active) return;
        if (!res.ok) throw new Error(body.error ?? "Couldn't read the review session.");
        setView(body);
        setError(null);
        if (body.mode === "archived") {
          setEvents(body.events);
          return;
        }
        if (body.mode !== "live") return;
        seen.current = new Set();
        setEvents([]);
        source = new EventSource(`${base}/stream`);
        source.onmessage = (message) => {
          let parsed;
          try {
            parsed = AgentEvent.safeParse(JSON.parse(message.data));
          } catch {
            return;
          }
          if (!parsed.success) return;
          const event = parsed.data;
          setEvents((prev) => appendEvent(prev, event, message.lastEventId, seen.current));
        };
        // EventSource retries a dropped stream on its own; one it gave up on
        // (its box went down: 204) is looked at again.
        source.onerror = () => {
          if (source?.readyState === EventSource.CLOSED && active) setGeneration((g) => g + 1);
        };
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Couldn't read the review session.");
      }
    })();
    return () => {
      active = false;
      source?.close();
    };
  }, [base, generation]);

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
          <InlineMessage actions={[{ label: "Try again", onClick: () => setGeneration((g) => g + 1) }]}>{error}</InlineMessage>
        </div>
      ) : view?.mode === "none" ? (
        <p className="p-6 text-[13px] text-muted-foreground">
          Its box is paused and it hasn&apos;t been archived, so there&apos;s nothing to read here yet. It&apos;s archived when the
          pull request gets new commits or closes.
        </p>
      ) : (
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
