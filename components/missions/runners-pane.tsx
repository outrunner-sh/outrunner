"use client";

/**
 * A Runner's Ships, in the right pane of its page (docs/missions.md):
 * grouped as Needs you, Ready to merge, Ready to review, Working and
 * Shipping, each with its task in a line, its pull request, its size and its
 * checks (listed on hover). A Ship clicked opens here, with its latest
 * response and a box to message it; Escape or Back returns to the list.
 */

import Link from "next/link";
import { ArrowLeft, ArrowUp, ChevronRight, ExternalLink, Users, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Markdown } from "@/components/markdown";
import { DiffSize, PullRequestChip, RunnerGlyph, UnreadDot } from "@/components/missions/mission-parts";
import { Spinner } from "@/components/ui/loaders";
import { SkeletonRows } from "@/components/ui/skeleton-swap";
import { refreshMissions, useMission } from "@/hooks/use-missions";
import { MAX_RUNNERS } from "@/lib/missions/rules";
import { RUNNER_GROUPS, type RunnerView } from "@/lib/missions/view";
import { cn } from "@/lib/utils";

const STATE_LABEL: Record<RunnerView["state"], string> = {
  setting_up: "Setting up",
  working: "Working",
  idle: "Idle",
  asleep: "Asleep",
  archived: "Archived",
  failed: "Failed",
  gone: "Gone",
};

export function RunnersPane({ missionId, onClose }: { missionId: string; onClose?: () => void }) {
  const { loaded, mission } = useMission(missionId);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const runners = useMemo(() => mission?.runners ?? [], [mission]);
  const open = runners.find((r) => r.id === openId) ?? null;
  const done = runners.filter((r) => r.group === "done");
  // The same function each render: the detail's effects mustn't restart on
  // every poll.
  const back = useCallback(() => setOpenId(null), []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-runner-row]") ?? []);
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    event.preventDefault();
    rows[Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  if (open) return <RunnerDetail missionId={missionId} runner={open} onBack={back} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="text-[13px] font-medium text-[#ededed]">Ships</h3>
          {mission && (
            <span
              className="truncate text-[12px] text-[#7a7a7a] tabular-nums"
              title={`${mission.liveRunners} of ${MAX_RUNNERS} places taken by Ships that aren't archived`}
            >
              {runners.length - done.length} with work · {MAX_RUNNERS - mission.liveRunners} places free
            </span>
          )}
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Hide Ships" className="studio-env-close">
            <X />
          </button>
        )}
      </div>
      <div ref={list} onKeyDown={onKeyDown} className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {!loaded ? (
          <div className="px-2 pt-2">
            <SkeletonRows rows={1} rowHeight={22} barHeight={7} />
            <SkeletonRows rows={3} rowHeight={46} indent={22} />
          </div>
        ) : runners.length === 0 ? (
          <div className="mx-2 mt-6 rounded-lg border border-dashed border-white/10 px-5 py-7 text-center">
            <span className="mx-auto mb-3 grid size-9 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-[#9a9a9a]">
              <Users className="size-4" />
            </span>
            <p className="text-[13px] text-[#ededed]">No Ships yet</p>
            <p className="mx-auto mt-1.5 max-w-[240px] text-[12px] leading-relaxed text-[#7a7a7a]">
              Tell the Runner what you need. It starts a Ship for each piece of work, and they show up here as they go.
            </p>
          </div>
        ) : (
          <>
            {RUNNER_GROUPS.map(({ key, label }) => {
              const group = runners.filter((r) => r.group === key);
              if (group.length === 0) return null;
              return (
                <section key={key} className="mission-in mt-2 first:mt-0" aria-label={label}>
                  <h4 className="flex items-center gap-2 px-2 py-1.5 text-[11.5px] font-medium tracking-wide text-[#8a8a8a] uppercase">
                    {label}
                    <span className="tabular-nums text-[#5f5f5f]">{group.length}</span>
                  </h4>
                  <ul className="space-y-px">
                    {group.map((runner) => (
                      <li key={runner.id}>
                        <RunnerRow runner={runner} onOpen={() => setOpenId(runner.id)} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {done.length > 0 && (
              <section className="mt-3">
                <button
                  type="button"
                  onClick={() => setShowDone((s) => !s)}
                  aria-expanded={showDone}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-[11.5px] font-medium tracking-wide text-[#6f6f6f] uppercase hover:text-[#a3a3a3]"
                >
                  <ChevronRight className={cn("size-3 transition-transform", showDone && "rotate-90")} />
                  Archived <span className="tabular-nums">{done.length}</span>
                </button>
                {showDone && (
                  <ul className="space-y-px">
                    {done.map((runner) => (
                      <li key={runner.id}>
                        <RunnerRow runner={runner} onOpen={() => setOpenId(runner.id)} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RunnerRow({ runner, onOpen }: { runner: RunnerView; onOpen: () => void }) {
  const pr = runner.pulls.find((p) => p.state === "open") ?? runner.pulls[runner.pulls.length - 1];
  return (
    // A row that opens the Ship, holding its pull request's link: a link
    // can't sit inside a button, so the row is a focusable div that answers
    // Enter and Space as one would.
    <div
      role="button"
      tabIndex={0}
      data-runner-row=""
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group/row flex w-full cursor-pointer flex-col gap-1 rounded-md px-2 py-2 text-left transition-colors hover:bg-white/[0.04] focus-visible:bg-white/[0.05] focus-visible:outline-none"
    >
      <span className="flex w-full items-center gap-2">
        <RunnerGlyph group={runner.group} state={runner.state} standing={runner.standing} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-[#ededed]">{runner.name}</span>
        <UnreadDot standing={runner.standing} />
        {pr && <DiffSize additions={pr.additions} deletions={pr.deletions} />}
      </span>
      {runner.summary && <span className="block truncate pl-[22px] text-[12px] text-[#7f7f7f]">{runner.summary}</span>}
      {runner.attention && <span className="block truncate pl-[22px] text-[12px] text-brand">{runner.attention}</span>}
      {pr && (
        <span className="flex min-w-0 items-center gap-2 pl-[22px]">
          <PullRequestChip pr={pr} showTitle />
          {runner.pulls.length > 1 && <span className="shrink-0 text-[11px] text-[#6f6f6f]">+{runner.pulls.length - 1}</span>}
        </span>
      )}
    </div>
  );
}

type Detail = { brief: string | null; latestResponse: string | null; live: boolean; status: string };

/** One Ship, opened in the pane: its latest response, its pull requests,
 *  its brief, and a box to message it. */
function RunnerDetail({ missionId, runner, onBack }: { missionId: string; runner: RunnerView; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  // The message being written, for Escape to leave alone wherever focus is.
  const draft = useRef("");
  const back = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/missions/${missionId}/runners/${runner.id}`, { cache: "no-store" }).catch(() => null);
    if (response?.ok) {
      setDetail((await response.json()) as Detail);
      setReadError(null);
    } else {
      setReadError("Its latest response couldn't be read. Trying again.");
    }
  }, [missionId, runner.id]);

  // Focus goes to Back once, as it opens; never again while it's open.
  useEffect(() => {
    back.current?.focus();
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first look, then every 10s
    void load();
    const timer = setInterval(() => void load(), 10_000);
    const onKey = (e: KeyboardEvent) => {
      // Not an Escape a menu or dialog took (Radix prevents its default), and
      // not while a message is being written: it mustn't throw that away.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (draft.current.trim()) return;
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [load, onBack]);

  const canMessage = runner.state === "idle" || runner.state === "working";
  const send = async () => {
    const content = message.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${runner.id}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "It didn't send. Try again.");
      setMessage("");
      draft.current = "";
      setSent(true);
      void refreshMissions();
      setTimeout(() => setSent(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mission-in flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/[0.06] pr-3 pl-2">
        <button
          ref={back}
          type="button"
          onClick={onBack}
          aria-label="Back to Ships"
          className="rounded-md p-1.5 text-[#8f8f8f] transition-colors hover:bg-white/[0.05] hover:text-[#ededed]"
        >
          <ArrowLeft className="size-4" />
        </button>
        <RunnerGlyph group={runner.group} state={runner.state} standing={runner.standing} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#ededed]">{runner.name}</span>
        <span className="shrink-0 text-[11.5px] text-[#7a7a7a]">{STATE_LABEL[runner.state]}</span>
        <Link
          href={`/workspaces/${runner.id}`}
          title="Open its session"
          aria-label={`Open ${runner.name}'s session`}
          className="rounded-md p-1.5 text-[#8f8f8f] transition-colors hover:bg-white/[0.05] hover:text-[#ededed]"
        >
          <ExternalLink className="size-3.5" />
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {runner.attention && (
          <p className="mb-3 rounded-md border border-brand/25 bg-brand/[0.07] px-3 py-2 text-[12.5px] text-[#ffb35c]">{runner.attention}</p>
        )}
        {runner.pulls.length > 0 && (
          <ul className="mb-4 space-y-1.5">
            {runner.pulls.map((pr) => (
              <li key={`${pr.repo}#${pr.number}`} className="rounded-md border border-white/[0.07] bg-white/[0.02] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <PullRequestChip pr={pr} />
                  <DiffSize additions={pr.additions} deletions={pr.deletions} />
                </div>
                <p className="mt-1.5 truncate text-[12.5px] text-[#d6d6d6]">{pr.title}</p>
                {pr.reason && <p className="mt-0.5 text-[12px] text-[#7f7f7f]">{pr.reason}</p>}
              </li>
            ))}
          </ul>
        )}
        <h4 className="mb-2 text-[11.5px] font-medium tracking-wide text-[#8a8a8a] uppercase">Latest response</h4>
        {detail === null && readError ? (
          <p role="alert" className="text-[12.5px] text-[#ffa198]">
            {readError}
          </p>
        ) : detail === null ? (
          <SkeletonRows rows={5} rowHeight={20} barHeight={7} />
        ) : detail.latestResponse ? (
          <div className="text-[13px] leading-relaxed text-[#d6d6d6]">
            <Markdown>{detail.latestResponse}</Markdown>
          </div>
        ) : (
          <p className="text-[12.5px] text-[#7a7a7a]">{runner.state === "setting_up" ? "Its box is being set up." : "Nothing yet."}</p>
        )}
        {detail?.brief && (
          <details className="group/brief mt-5">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11.5px] font-medium tracking-wide text-[#8a8a8a] uppercase hover:text-[#bdbdbd]">
              <ChevronRight className="size-3 transition-transform group-open/brief:rotate-90" />
              Brief
            </summary>
            <div className="mt-2 rounded-md border border-white/[0.06] bg-black/20 px-3 py-2 text-[12.5px] leading-relaxed text-[#bdbdbd]">
              <Markdown>{detail.brief}</Markdown>
            </div>
          </details>
        )}
      </div>
      <div className="shrink-0 border-t border-white/[0.06] p-3">
        {error && <p className="mb-2 text-[12px] text-[#ffa198]">{error}</p>}
        <div className="rounded-md border border-white/10 bg-black/20 focus-within:border-white/25">
          <textarea
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              draft.current = e.target.value;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={!canMessage}
            rows={2}
            placeholder={canMessage ? `Message ${runner.name}…` : "Open its session to wake or restore it"}
            className="block w-full resize-none bg-transparent px-3 pt-2 text-[13px] text-[#ededed] outline-none placeholder:text-[#5f5f5f] disabled:cursor-not-allowed"
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="pl-1 text-[11px] text-[#5f5f5f]">{sent ? "Sent" : runner.state === "working" ? "Steers its turn" : "Starts a turn"}</span>
            <button
              type="button"
              onClick={() => void send()}
              disabled={!canMessage || !message.trim() || sending}
              aria-label="Send"
              className="grid size-7 place-items-center rounded bg-[#ededed] text-[#0a0a0a] transition-colors hover:bg-white disabled:bg-white/10 disabled:text-white/40"
            >
              {sending ? <Spinner className="size-3.5" label="Sending" /> : <ArrowUp className="size-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
