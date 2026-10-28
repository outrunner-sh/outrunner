"use client";

import { Plus, X } from "lucide-react";
import { useMemo, useSyncExternalStore } from "react";

import { Input } from "@/components/ui/input";
import {
  describeSchedule,
  MIN_INTERVAL_MINUTES,
  nextRun,
  parseSchedule,
  runTooOften,
  type Schedule,
  type ScheduleKind,
  SCHEDULES_MAX,
  upcomingRuns,
  WEEKDAYS,
} from "@/lib/automations/schedule";
import { cn } from "@/lib/utils";

/** A schedule as the editor holds it: every kind's fields at once, so
 *  switching kind and back keeps what was typed. */
export type ScheduleForm = {
  key: string;
  kind: ScheduleKind;
  timezone: string;
  days: number[];
  time: string;
  day: number;
  at: string;
  expression: string;
};

const KIND_LABELS: Record<ScheduleKind, string> = { weekly: "Weekly", monthly: "Monthly", once: "Once", cron: "Cron" };

let made = 0;

export function scheduleForm(timezone: string, schedule?: Schedule): ScheduleForm {
  made += 1;
  const base: ScheduleForm = {
    key: `s${made}`,
    kind: "weekly",
    timezone,
    days: [1, 2, 3, 4, 5],
    time: "09:00",
    day: 1,
    at: "",
    expression: "0 9 * * 1-5",
  };
  return schedule ? { ...base, ...schedule } : base;
}

/** What's sent of a row: its kind's fields (the server checks them). */
export function scheduleOf(form: ScheduleForm): unknown {
  const { kind, timezone } = form;
  switch (kind) {
    case "weekly":
      return { kind, timezone, days: form.days, time: form.time };
    case "monthly":
      return { kind, timezone, day: form.day, time: form.time };
    case "once":
      return { kind, timezone, at: form.at };
    case "cron":
      return { kind, timezone, expression: form.expression };
  }
}

const noSubscription = () => () => {};
/** Ticks each half minute, for the preview's "next runs". */
const everyHalfMinute = (onChange: () => void) => {
  const id = setInterval(onChange, 30_000);
  return () => clearInterval(id);
};
const thisMinute = () => Math.floor(Date.now() / 60_000) * 60_000;

let zones: string[] | null = null;
/** The browser's time zones, UTC first: read once, after the page is up (the
 *  server's list may not be the browser's). */
const browserZones = () => (zones ??= ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")]);
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The browser's own time zone; UTC on the server. */
export function useLocalZone(): string {
  return useSyncExternalStore(noSubscription, localZone, () => "UTC");
}

/**
 * An automation's schedules, each weekly, monthly, once or cron in a time
 * zone, and the next runs they make together: what the tick will start, in
 * each schedule's zone and in the browser's.
 */
export function AutomationSchedules({
  schedules,
  onChange,
  editable,
}: {
  schedules: ScheduleForm[];
  onChange: (schedules: ScheduleForm[]) => void;
  editable: boolean;
}) {
  const now = useSyncExternalStore(everyHalfMinute, thisMinute, () => null);
  const zoneList = useSyncExternalStore(noSubscription, browserZones, () => null);
  const local = useLocalZone();
  const set = (key: string, change: Partial<ScheduleForm>) =>
    onChange(schedules.map((s) => (s.key === key ? { ...s, ...change } : s)));
  // Worked out again only when the schedules or the minute change: the
  // floor across them asks each schedule's next runs of every other, which
  // for a rare cron walks years ahead.
  const { checked, valid, upcoming, tooOften } = useMemo(() => {
    const checked = schedules.map((form) => (now === null ? null : parseSchedule(scheduleOf(form), now)));
    const valid = checked.flatMap((c) => (c?.ok ? [c.value] : []));
    return {
      checked,
      valid,
      upcoming: now === null ? [] : upcomingRuns(valid, now, 5),
      tooOften: now !== null && valid.length > 1 && runTooOften(valid, now),
    };
  }, [schedules, now]);

  return (
    <div className="space-y-3">
      {schedules.map((form, index) => {
        const check = checked[index];
        return (
          <div key={form.key} className="space-y-2 rounded-lg border border-border/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Repeats"
                value={form.kind}
                disabled={!editable}
                onChange={(event) => set(form.key, { kind: event.target.value as ScheduleKind })}
                className={SELECT}
              >
                {(Object.keys(KIND_LABELS) as ScheduleKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
              {form.kind === "monthly" ? (
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  on day
                  <Input
                    type="number"
                    min={1}
                    max={31}
                    value={form.day}
                    disabled={!editable}
                    onChange={(event) => set(form.key, { day: Number(event.target.value) })}
                    className="h-7 w-16 text-xs"
                  />
                </label>
              ) : null}
              {form.kind === "weekly" || form.kind === "monthly" ? (
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  at
                  <Input
                    type="time"
                    value={form.time}
                    disabled={!editable}
                    onChange={(event) => set(form.key, { time: event.target.value })}
                    className="h-7 w-32 text-xs"
                  />
                </label>
              ) : null}
              {form.kind === "once" ? (
                <Input
                  type="datetime-local"
                  aria-label="Runs at"
                  value={form.at}
                  disabled={!editable}
                  onChange={(event) => set(form.key, { at: event.target.value.slice(0, 16) })}
                  className="h-7 w-52 text-xs"
                />
              ) : null}
              {form.kind === "cron" ? (
                <Input
                  aria-label="Cron expression"
                  value={form.expression}
                  disabled={!editable}
                  onChange={(event) => set(form.key, { expression: event.target.value })}
                  placeholder="0 9 * * 1-5"
                  className="h-7 w-44 font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
              ) : null}
              <select
                aria-label="Time zone"
                value={form.timezone}
                disabled={!editable}
                onChange={(event) => set(form.key, { timezone: event.target.value })}
                className={cn(SELECT, "max-w-56")}
              >
                {(zoneList?.includes(form.timezone) ? zoneList : [form.timezone, ...(zoneList ?? [])]).map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
              {editable ? (
                <button
                  type="button"
                  aria-label="Remove schedule"
                  onClick={() => onChange(schedules.filter((s) => s.key !== form.key))}
                  className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>
            {form.kind === "weekly" ? (
              <div className="flex flex-wrap gap-1" role="group" aria-label="Days">
                {WEEKDAYS.map((name, day) => {
                  const on = form.days.includes(day);
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={on}
                      disabled={!editable}
                      onClick={() =>
                        set(form.key, { days: on ? form.days.filter((d) => d !== day) : [...form.days, day].sort((a, b) => a - b) })
                      }
                      className={cn(
                        "h-6 w-10 rounded text-xs transition-colors disabled:cursor-default",
                        on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {form.kind === "cron" ? (
              <p className="text-xs text-muted-foreground">
                Minute, hour, day of month, month, day of week: <span className="font-mono">0 9 * * 1-5</span> is 09:00 on
                weekdays.
              </p>
            ) : null}
            {check && !check.ok ? (
              <p className="text-xs text-warning">{check.error}</p>
            ) : check?.ok && now !== null && check.value.kind === "once" && nextRun(check.value, now) === null ? (
              <p className="text-xs text-warning">That time has passed: it won&apos;t run.</p>
            ) : null}
          </div>
        );
      })}
      <div className="flex items-center justify-between gap-3">
        {editable && schedules.length < SCHEDULES_MAX ? (
          <button
            type="button"
            onClick={() => onChange([...schedules, scheduleForm(local)])}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus className="size-3.5" /> Add schedule
          </button>
        ) : (
          <span />
        )}
      </div>
      {tooOften ? (
        <p className="text-xs text-warning">
          Together, these run more often than every {MIN_INTERVAL_MINUTES} minutes: space them out to save.
        </p>
      ) : null}
      {valid.length > 0 ? (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Next runs</div>
          {upcoming.length === 0 ? (
            <p className="text-xs text-muted-foreground">None: every schedule has passed.</p>
          ) : (
            <ul className="space-y-0.5 text-xs text-foreground/80">
              {upcoming.map(({ at, schedule }) => {
                const zone = valid[schedule].timezone;
                return (
                  <li key={at}>
                    {when(at, zone)}
                    {zone !== local ? <span className="text-muted-foreground"> · {when(at, local)}</span> : null}
                    <span className="text-muted-foreground"> · {describeSchedule(valid[schedule])}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Each run starts within two minutes of its time, on each of the automation&apos;s repositories.
          </p>
        </div>
      ) : null}
    </div>
  );
}

const SELECT = "h-7 rounded-md border border-border/60 bg-background px-2 text-xs text-foreground disabled:opacity-70";

function when(at: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
    timeZoneName: "short",
  }).format(new Date(at));
}
