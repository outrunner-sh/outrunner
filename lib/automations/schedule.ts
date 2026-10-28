/**
 * An automation's schedules: weekly, monthly, once, or a cron expression,
 * each in an IANA time zone, and when each fires next. No I/O, so the
 * editor's preview of the next runs and the tick that fires them
 * (lib/automations/runs.ts, planScheduledRuns) agree on every one.
 *
 * Times are the zone's wall-clock times: 09:00 in Europe/Berlin is 09:00
 * there in summer and in winter. A time a clock change skips (02:30 the
 * night clocks go forward) runs when the clock reads it an hour on; a time
 * it repeats (02:30 the night they go back) runs once, the first time.
 */

export const SCHEDULE_KINDS = ["weekly", "monthly", "once", "cron"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export type Schedule =
  /** On these days of the week (0 Sunday to 6 Saturday), at `time` ("HH:MM"). */
  | { kind: "weekly"; timezone: string; days: number[]; time: string }
  /** On this day of every month (1 to 31: a shorter month runs on its last
   *  day), at `time`. */
  | { kind: "monthly"; timezone: string; day: number; time: string }
  /** Once, at `at` ("YYYY-MM-DDTHH:MM", the zone's wall clock). */
  | { kind: "once"; timezone: string; at: string }
  /** A five-field cron expression (minute hour day month weekday). */
  | { kind: "cron"; timezone: string; expression: string };

/** Enough for any one automation; more is a mistake. */
export const SCHEDULES_MAX = 10;

/** The closest two runs of one schedule may be: the tick that fires them
 *  comes every 2 minutes, and each run is a session, with a box. */
export const MIN_INTERVAL_MINUTES = 15;

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** How far ahead a next run is looked for: past a leap day's four years, so
 *  "0 9 29 2 *" is found and only an expression that never fires isn't. */
const HORIZON_DAYS = 366 * 5;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Time zones

/** Formatters by zone: making one is the slow part of reading a wall clock. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** Whether `value` is an IANA time zone this runtime knows. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return false;
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

/** A wall clock's reading, to the minute. */
export type WallTime = { year: number; month: number; day: number; hour: number; minute: number };

/** What the wall clock in `timezone` reads at `instant` (ms). */
export function wallTime(instant: number, timezone: string): WallTime & { second: number } {
  const parts: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** How far ahead of UTC the zone's clock is at `instant`, in ms. */
function offsetAt(instant: number, timezone: string): number {
  const w = wallTime(instant, timezone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant the zone's clock reads `wall`. Read with the offsets half a
 * day either side (no zone changes its clock twice in a day): a reading that
 * happens twice is the first; one that never happens (skipped forward) is
 * the instant it would have been on the old offset, which the clock reads as
 * that much later.
 */
export function zonedInstant(wall: WallTime, timezone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const before = asUtc - offsetAt(asUtc - DAY / 2, timezone);
  const after = asUtc - offsetAt(asUtc + DAY / 2, timezone);
  const reads = (instant: number) => {
    const w = wallTime(instant, timezone);
    return w.year === wall.year && w.month === wall.month && w.day === wall.day && w.hour === wall.hour && w.minute === wall.minute;
  };
  const matches = [before, after].filter(reads);
  return matches.length > 0 ? Math.min(...matches) : before;
}

// ---------------------------------------------------------------------------
// Cron

export type CronSpec = {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Whether the day-of-month and weekday fields were each restricted (not
   *  `*`): when both are, a day matching either runs, as cron has it. */
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
};

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function cronField(field: string, min: number, max: number, names?: string[], nameBase = 0): number[] | null {
  const values = new Set<number>();
  const value = (text: string): number | null => {
    const named = names?.indexOf(text.toUpperCase()) ?? -1;
    if (named >= 0) return named + nameBase;
    if (!/^\d{1,2}$/.test(text)) return null;
    return Number(text);
  };
  for (const item of field.split(",")) {
    const match = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d{1,2}))?$/.exec(item);
    if (!match) return null;
    const [, range, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return null;
    let from: number | null;
    let to: number | null;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      from = value(a);
      to = value(b);
    } else {
      from = value(range);
      // "5/15": from 5 to the end, every 15.
      to = stepText === undefined ? from : max;
    }
    if (from === null || to === null || from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/** A cron expression's fields, or null when it isn't one. */
export function parseCron(expression: string): CronSpec | null {
  const trimmed = expression.trim().replace(/\s+/g, " ");
  const fields = (MACROS[trimmed.toLowerCase()] ?? trimmed).split(" ");
  if (fields.length !== 5) return null;
  const [minute, hour, day, month, weekday] = fields;
  const minutes = cronField(minute, 0, 59);
  const hours = cronField(hour, 0, 23);
  const days = cronField(day, 1, 31);
  const months = cronField(month, 1, 12, MONTH_NAMES, 1);
  // 0 and 7 are both Sunday.
  const weekdays = cronField(weekday, 0, 7, DAY_NAMES);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  return {
    minutes,
    hours,
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays.map((d) => d % 7)),
    daysRestricted: !day.startsWith("*"),
    weekdaysRestricted: !weekday.startsWith("*"),
  };
}

// ---------------------------------------------------------------------------
// Next runs

function hm(time: string): [number, number] {
  const [h, m] = time.split(":").map(Number);
  return [h, m];
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** What a recurring schedule fires on: which days, and at which times of
 *  them (ascending). */
type Recurrence = {
  matches(year: number, month: number, day: number, weekday: number): boolean;
  times: [number, number][];
};

function recurrence(schedule: Schedule): Recurrence | null {
  switch (schedule.kind) {
    case "weekly":
      return { matches: (_y, _m, _d, weekday) => schedule.days.includes(weekday), times: [hm(schedule.time)] };
    case "monthly":
      return {
        matches: (y, m, d) => d === Math.min(schedule.day, daysInMonth(y, m)),
        times: [hm(schedule.time)],
      };
    case "cron": {
      const spec = parseCron(schedule.expression);
      if (!spec) return null;
      const times = spec.hours.flatMap((h) => spec.minutes.map((m) => [h, m] as [number, number]));
      return {
        matches: (_y, m, d, weekday) => {
          if (!spec.months.has(m)) return false;
          const dayOk = spec.days.has(d);
          const weekdayOk = spec.weekdays.has(weekday);
          if (spec.daysRestricted && spec.weekdaysRestricted) return dayOk || weekdayOk;
          return dayOk && weekdayOk;
        },
        times,
      };
    }
    case "once":
      return null;
  }
}

/** When `schedule` fires next after `after` (ms, exclusive); null when it
 *  never does again (a time passed, or an expression with no date). */
export function nextRun(schedule: Schedule, after: number): number | null {
  if (schedule.kind === "once") {
    const at = parseLocal(schedule.at);
    if (!at) return null;
    const instant = zonedInstant(at, schedule.timezone);
    return instant > after ? instant : null;
  }
  const rule = recurrence(schedule);
  if (!rule) return null;
  // From the day before the clock's: a time pushed past midnight by a clock
  // change still belongs to its own day.
  const start = wallTime(after - DAY, schedule.timezone);
  let date = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i < HORIZON_DAYS; i++, date += DAY) {
    const d = new Date(date);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    if (!rule.matches(year, month, day, d.getUTCDay())) continue;
    for (const [hour, minute] of rule.times) {
      // No zone is more than 14 hours behind UTC: a reading that early is
      // before `after` without asking the zone.
      if (Date.UTC(year, month - 1, day, hour, minute) + 14 * 60 * MINUTE <= after) continue;
      const instant = zonedInstant({ year, month, day, hour, minute }, schedule.timezone);
      if (instant > after) return instant;
    }
  }
  return null;
}

/** Its next `count` runs after `after`, in order. */
export function nextRuns(schedule: Schedule, after: number, count: number): number[] {
  const runs: number[] = [];
  let from = after;
  while (runs.length < count) {
    const next = nextRun(schedule, from);
    if (next === null) break;
    runs.push(next);
    from = next;
  }
  return runs;
}

/** The next `count` runs of all an automation's schedules together, each
 *  instant once (two schedules due at once run once), with the first
 *  schedule (by index) due then. */
export function upcomingRuns(schedules: readonly Schedule[], after: number, count: number): { at: number; schedule: number }[] {
  const all = new Map<number, number>();
  schedules.forEach((schedule, index) => {
    for (const at of nextRuns(schedule, after, count)) if (!all.has(at)) all.set(at, index);
  });
  return [...all]
    .sort((a, b) => a[0] - b[0])
    .slice(0, count)
    .map(([at, schedule]) => ({ at, schedule }));
}

/**
 * Whether an automation's schedules together run closer than
 * MIN_INTERVAL_MINUTES apart: each on its own may keep to it while three of
 * them, staggered, run every five minutes. Each keeps the gap alone, so only
 * the gaps between them are looked at: each one's next runs, against every
 * other's nearest. Over each schedule's own span, so a rare one (Mondays)
 * isn't missed beside a frequent one (hourly). A time two share is one run.
 */
export function runTooOften(schedules: readonly Schedule[], now: number): boolean {
  const gap = MIN_INTERVAL_MINUTES * MINUTE;
  return schedules.some((schedule, i) =>
    nextRuns(schedule, now, 30).some((at) =>
      schedules.some((other, j) => {
        if (j === i) return false;
        const [near] = nextRuns(other, at - gap, 1);
        return near !== undefined && near !== at && Math.abs(near - at) < gap;
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// What may be saved

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

function parseLocal(at: string): WallTime | null {
  const match = LOCAL.exec(at);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day, hour, minute };
}

/** A schedule's shape, checked: its fields, not when it runs. */
function readSchedule(value: unknown): Parsed<Schedule> {
  if (typeof value !== "object" || value === null) return { ok: false, error: "That isn't a schedule." };
  const v = value as Record<string, unknown>;
  if (!isTimeZone(v.timezone)) return { ok: false, error: "Pick a time zone for each schedule." };
  const timezone = v.timezone;
  switch (v.kind) {
    case "weekly": {
      const days = Array.isArray(v.days) ? [...new Set(v.days)] : [];
      if (days.length === 0 || !days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) {
        return { ok: false, error: "Pick at least one day for a weekly schedule." };
      }
      if (typeof v.time !== "string" || !TIME.test(v.time)) return { ok: false, error: "Give each schedule a time, as HH:MM." };
      return { ok: true, value: { kind: "weekly", timezone, days: (days as number[]).sort((a, b) => a - b), time: v.time } };
    }
    case "monthly": {
      if (typeof v.day !== "number" || !Number.isInteger(v.day) || v.day < 1 || v.day > 31) {
        return { ok: false, error: "Pick a day of the month from 1 to 31." };
      }
      if (typeof v.time !== "string" || !TIME.test(v.time)) return { ok: false, error: "Give each schedule a time, as HH:MM." };
      return { ok: true, value: { kind: "monthly", timezone, day: v.day, time: v.time } };
    }
    case "once": {
      if (typeof v.at !== "string" || !parseLocal(v.at)) return { ok: false, error: "Give a run-once schedule a date and time." };
      return { ok: true, value: { kind: "once", timezone, at: v.at } };
    }
    case "cron": {
      const expression = typeof v.expression === "string" ? v.expression.trim().replace(/\s+/g, " ") : "";
      if (expression.length > 120 || !parseCron(expression)) {
        return { ok: false, error: "That cron expression isn't one: five fields, minute hour day month weekday." };
      }
      return { ok: true, value: { kind: "cron", timezone, expression } };
    }
    default:
      return { ok: false, error: "A schedule is weekly, monthly, once or cron." };
  }
}

/** A schedule as the page sends it, checked; `now` (ms) finds a recurring
 *  one that runs too often, or never. A once in the past is kept (it ran,
 *  or it's saved unchanged): it fires no more. */
export function parseSchedule(value: unknown, now: number): Parsed<Schedule> {
  const read = readSchedule(value);
  if (!read.ok || read.value.kind === "once") return read;
  const schedule = read.value;
  const runs = nextRuns(schedule, now, 30);
  if (runs.length === 0) return { ok: false, error: "That schedule never runs." };
  for (let i = 1; i < runs.length; i++) {
    if (runs[i] - runs[i - 1] < MIN_INTERVAL_MINUTES * MINUTE) {
      return { ok: false, error: `A schedule runs at most every ${MIN_INTERVAL_MINUTES} minutes.` };
    }
  }
  return { ok: true, value: schedule };
}

/** The same schedule, field for field: saving it unchanged changes nothing. */
export function sameSchedule(a: Schedule, b: Schedule): boolean {
  return a.kind === b.kind && a.timezone === b.timezone && JSON.stringify(scheduleSpec(a)) === JSON.stringify(scheduleSpec(b));
}

/** What's stored of a schedule beside its kind and zone (automation_schedules.spec). */
export function scheduleSpec(schedule: Schedule): { [key: string]: string | number | number[] } {
  switch (schedule.kind) {
    case "weekly":
      return { days: schedule.days, time: schedule.time };
    case "monthly":
      return { day: schedule.day, time: schedule.time };
    case "once":
      return { at: schedule.at };
    case "cron":
      return { expression: schedule.expression };
  }
}

/** A stored schedule as one; null for a row that isn't (none is written but
 *  through parseSchedule). */
export function scheduleFromRow(row: { kind: string; timezone: string; spec: unknown }): Schedule | null {
  const read = readSchedule({ ...((row.spec ?? {}) as Record<string, unknown>), kind: row.kind, timezone: row.timezone });
  return read.ok ? read.value : null;
}

/** One line on a schedule, as the page shows it. */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case "weekly":
      return schedule.days.length === 7
        ? `Every day at ${schedule.time}`
        : `Every ${schedule.days.map((d) => WEEKDAYS[d]).join(", ")} at ${schedule.time}`;
    case "monthly":
      return schedule.day > 28
        ? `Monthly on day ${schedule.day} (or the month's last) at ${schedule.time}`
        : `Monthly on day ${schedule.day} at ${schedule.time}`;
    case "once":
      return `Once, on ${schedule.at.replace("T", " at ")}`;
    case "cron":
      return `Cron ${schedule.expression}`;
  }
}
