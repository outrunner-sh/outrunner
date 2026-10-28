"use client";

import { Input } from "@/components/ui/input";
import { MAX_RUNS_MAX, type SessionMode } from "@/lib/automations/rules";

/** How an automation runs, beside when: how many times, whether triggers
 *  close together are one run, and in which session. */
export type Limits = {
  maxRuns: number | null;
  archiveWhenDone: boolean;
  debounceSeconds: number;
  sessionMode: SessionMode;
};

/** The debounce windows offered: none, then from 30 seconds to an hour. */
const WINDOWS: [number, string][] = [
  [0, "Off: each trigger runs"],
  [30, "30 seconds"],
  [60, "1 minute"],
  [120, "2 minutes"],
  [300, "5 minutes"],
  [600, "10 minutes"],
  [900, "15 minutes"],
  [1800, "30 minutes"],
  [3600, "1 hour"],
];

const SELECT = "h-7 rounded-md border border-border/60 bg-background px-2 text-xs text-foreground disabled:opacity-70";

/**
 * An automation's limits: run every time, once, or up to a count (then it
 * switches itself off, and archives itself too if asked); combine triggers
 * that come within a window of each other on the same pull request, issue,
 * schedule or webhook into one run, of the last; and a new session each run,
 * or one reused across them.
 */
export function AutomationLimits({
  limits,
  onChange,
  editable,
  runsUsed,
}: {
  limits: Limits;
  onChange: (limits: Limits) => void;
  editable: boolean;
  /** How many times it has run against its saved limit; null with none. */
  runsUsed: number | null;
}) {
  const set = (change: Partial<Limits>) => onChange({ ...limits, ...change });
  const count = limits.maxRuns === null ? "every" : limits.maxRuns === 1 ? "once" : "count";
  const radio = (name: string, value: string, checked: boolean, onSelect: () => void, label: React.ReactNode) => (
    <label className="flex items-center gap-2 text-[13px] text-foreground">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={!editable}
        onChange={onSelect}
        className="size-3.5 accent-[var(--primary)]"
      />
      {label}
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="text-xs text-muted-foreground">How many times</div>
        {radio("max-runs", "every", count === "every", () => set({ maxRuns: null }), "Every time it's triggered")}
        {radio("max-runs", "once", count === "once", () => set({ maxRuns: 1 }), "Once")}
        {radio(
          "max-runs",
          "count",
          count === "count",
          () => set({ maxRuns: limits.maxRuns !== null && limits.maxRuns > 1 ? limits.maxRuns : 5 }),
          <span className="flex items-center gap-1.5">
            Up to
            <Input
              type="number"
              min={2}
              max={MAX_RUNS_MAX}
              value={count === "count" ? (limits.maxRuns ?? 5) : 5}
              disabled={!editable || count !== "count"}
              onChange={(event) => set({ maxRuns: Math.max(2, Math.min(MAX_RUNS_MAX, Number(event.target.value) || 2)) })}
              className="h-7 w-20 text-xs"
              aria-label="Runs at most"
            />
            times
          </span>,
        )}
        {limits.maxRuns !== null ? (
          <div className="space-y-1 pl-5">
            <label className="flex items-center gap-2 text-[13px] text-foreground">
              <input
                type="checkbox"
                checked={limits.archiveWhenDone}
                disabled={!editable}
                onChange={() => set({ archiveWhenDone: !limits.archiveWhenDone })}
                className="size-3.5 accent-[var(--primary)]"
              />
              Archive it when done
            </label>
            <p className="text-xs text-muted-foreground">
              {runsUsed !== null ? `It has run ${runsUsed === 1 ? "once" : `${runsUsed} times`} of its count. ` : ""}
              Once it has run its count it switches itself off; switching it on again counts afresh. A trigger that runs it
              on several repositories at once is one time.
            </p>
          </div>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="automation-debounce" className="text-xs text-muted-foreground">
          Combine triggers within
        </label>
        <div>
          <select
            id="automation-debounce"
            value={limits.debounceSeconds}
            disabled={!editable}
            onChange={(event) => set({ debounceSeconds: Number(event.target.value) })}
            className={SELECT}
          >
            {WINDOWS.map(([seconds, label]) => (
              <option key={seconds} value={seconds}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {limits.debounceSeconds > 0 ? (
          <p className="text-xs text-muted-foreground">
            A run waits this long after its trigger; another on the same pull request, issue, schedule or webhook meanwhile
            joins it and starts the wait again. It then runs once, for the last of them.
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <div className="text-xs text-muted-foreground">Session</div>
        {radio("session-mode", "new", limits.sessionMode === "new", () => set({ sessionMode: "new" }), "A new session for each run")}
        {radio(
          "session-mode",
          "reuse",
          limits.sessionMode === "reuse",
          () => set({ sessionMode: "reuse" }),
          "Reuse one session across runs on the same thing",
        )}
        {limits.sessionMode === "reuse" ? (
          <p className="text-xs text-muted-foreground">
            Each run is sent to the automation&apos;s last session on the same pull request, issue, schedule or webhook (in
            each repository), woken or restored first, so it keeps what it learned there; one that can&apos;t be woken is
            replaced by a new one. Runs on different pull requests or issues get sessions of their own.
          </p>
        ) : null}
      </div>
    </div>
  );
}
