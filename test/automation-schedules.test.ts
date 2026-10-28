import assert from "node:assert/strict";
import { test } from "node:test";

import { eventPrompt, eventTitle, readRunEvent, type ScheduleEvent } from "@/lib/automations/run-event";
import { parseAutomationInput } from "@/lib/automations/rules";
import { planScheduledRuns, rerunRun, type ScheduleDeps, startRun, type StartDeps } from "@/lib/automations/runs";
import {
  describeSchedule,
  nextRun,
  nextRuns,
  parseCron,
  parseSchedule,
  type Schedule,
  upcomingRuns,
  zonedInstant,
} from "@/lib/automations/schedule";
import type { DueSchedule, RerunTarget, RunCandidate, RunRecord } from "@/lib/db/automation-runs";
import type { ServerSessionStart } from "@/lib/session/server-session";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const NOW = at("2026-10-28T12:00:00Z");

test("a weekly schedule keeps to its zone's clock, either side of a clock change", () => {
  const monday: Schedule = { kind: "weekly", timezone: "Europe/Berlin", days: [1], time: "09:00" };
  // Berlin is UTC+2 until the clocks go back on Oct 25, then UTC+1.
  assert.deepEqual(nextRuns(monday, at("2026-10-15T00:00:00Z"), 3).map(iso), [
    "2026-10-19T07:00:00.000Z",
    "2026-10-26T08:00:00.000Z",
    "2026-11-02T08:00:00.000Z",
  ]);
  // Exclusive of `after`: a run at 09:00 is next week's from 09:00 on.
  assert.equal(iso(nextRun(monday, at("2026-11-02T08:00:00Z"))), "2026-11-09T08:00:00.000Z");
});

test("a time a clock change skips runs an hour on; one it repeats runs the first time", () => {
  // Spring forward: 02:30 doesn't happen in Berlin on Mar 29, nor in New York on Mar 8.
  assert.equal(iso(zonedInstant({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, "Europe/Berlin")), "2026-03-29T01:30:00.000Z");
  assert.equal(iso(zonedInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York")), "2026-03-08T07:30:00.000Z");
  // Fall back: 02:30 happens twice in Berlin on Oct 25; the first is 00:30 UTC.
  assert.equal(iso(zonedInstant({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, "Europe/Berlin")), "2026-10-25T00:30:00.000Z");
  const nightly: Schedule = { kind: "cron", timezone: "Europe/Berlin", expression: "30 2 * * *" };
  // Once a night, the night the clocks go back included.
  assert.deepEqual(nextRuns(nightly, at("2026-10-24T12:00:00Z"), 2).map(iso), ["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
});

test("a monthly schedule on a day a month lacks runs on its last day", () => {
  const last: Schedule = { kind: "monthly", timezone: "UTC", day: 31, time: "18:00" };
  assert.deepEqual(nextRuns(last, NOW, 4).map(iso), [
    "2026-10-31T18:00:00.000Z",
    "2026-11-30T18:00:00.000Z",
    "2026-12-31T18:00:00.000Z",
    "2027-01-31T18:00:00.000Z",
  ]);
  assert.equal(iso(nextRun({ ...last, day: 30 }, at("2027-02-01T00:00:00Z"))), "2027-02-28T18:00:00.000Z");
});

test("a once runs once, at its zone's time, and never after", () => {
  const once: Schedule = { kind: "once", timezone: "Asia/Kolkata", at: "2026-11-02T09:30" };
  assert.equal(iso(nextRun(once, NOW)), "2026-11-02T04:00:00.000Z");
  assert.equal(nextRun(once, at("2026-11-02T04:00:00Z")), null);
  assert.deepEqual(nextRuns(once, NOW, 5).length, 1);
});

test("cron expressions read as cron has them: lists, ranges, steps, names, macros", () => {
  const weekdays = parseCron("0 9 * * MON-FRI");
  assert.ok(weekdays);
  assert.deepEqual([...weekdays.weekdays], [1, 2, 3, 4, 5]);
  assert.deepEqual(parseCron("*/20 8-10/2 * * *")?.minutes, [0, 20, 40]);
  assert.deepEqual(parseCron("*/20 8-10/2 * * *")?.hours, [8, 10]);
  assert.deepEqual([...(parseCron("0 0 * * 7")?.weekdays ?? [])], [0]);
  assert.deepEqual(parseCron("@weekly"), parseCron("0 0 * * 0"));
  for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "5-1 * * * *", "*/0 * * * *", "x * * * *"]) {
    assert.equal(parseCron(bad), null, bad);
  }
  // Day of month and weekday both set: either runs (the 1st, and Mondays).
  const either: Schedule = { kind: "cron", timezone: "UTC", expression: "0 9 1 * 1" };
  assert.deepEqual(nextRuns(either, at("2026-10-28T00:00:00Z"), 3).map(iso), [
    "2026-11-01T09:00:00.000Z",
    "2026-11-02T09:00:00.000Z",
    "2026-11-09T09:00:00.000Z",
  ]);
  // A leap day is found four years out.
  assert.equal(iso(nextRun({ kind: "cron", timezone: "UTC", expression: "0 9 29 2 *" }, NOW)), "2028-02-29T09:00:00.000Z");
});

test("a schedule that can't be saved is refused, saying why", () => {
  const refused: [string, unknown, RegExp][] = [
    ["no zone", { kind: "weekly", days: [1], time: "09:00" }, /time zone/],
    ["unknown zone", { kind: "weekly", timezone: "Mars/Olympus", days: [1], time: "09:00" }, /time zone/],
    ["no days", { kind: "weekly", timezone: "UTC", days: [], time: "09:00" }, /day/],
    ["bad day", { kind: "weekly", timezone: "UTC", days: [7], time: "09:00" }, /day/],
    ["bad time", { kind: "weekly", timezone: "UTC", days: [1], time: "9am" }, /HH:MM/],
    ["day 32", { kind: "monthly", timezone: "UTC", day: 32, time: "09:00" }, /1 to 31/],
    ["bad date", { kind: "once", timezone: "UTC", at: "2026-02-30T09:00" }, /date and time/],
    ["not cron", { kind: "cron", timezone: "UTC", expression: "every day" }, /cron expression/],
    ["too often", { kind: "cron", timezone: "UTC", expression: "*/5 * * * *" }, /every 15 minutes/],
    ["too close", { kind: "cron", timezone: "UTC", expression: "0,10 9 * * *" }, /every 15 minutes/],
    ["never", { kind: "cron", timezone: "UTC", expression: "0 9 31 2 *" }, /never runs/],
    ["no kind", { kind: "hourly", timezone: "UTC" }, /weekly, monthly, once or cron/],
  ];
  for (const [what, value, error] of refused) {
    const parsed = parseSchedule(value, NOW);
    assert.equal(parsed.ok, false, what);
    if (!parsed.ok) assert.match(parsed.error, error, what);
  }
  // A once in the past is kept: it ran, or it's saved unchanged.
  assert.ok(parseSchedule({ kind: "once", timezone: "UTC", at: "2020-01-01T09:00" }, NOW).ok);
  // Every 15 minutes is as often as one runs.
  assert.ok(parseSchedule({ kind: "cron", timezone: "UTC", expression: "*/15 * * * *" }, NOW).ok);
  const weekly = parseSchedule({ kind: "weekly", timezone: "UTC", days: [5, 1, 1], time: "09:00" }, NOW);
  assert.ok(weekly.ok);
  assert.deepEqual(weekly.value, { kind: "weekly", timezone: "UTC", days: [1, 5], time: "09:00" });
  assert.equal(describeSchedule(weekly.value), "Every Mon, Fri at 09:00");
});

test("the next runs of several schedules come together, a time two share once", () => {
  const morning: Schedule = { kind: "weekly", timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6], time: "09:00" };
  const monday: Schedule = { kind: "cron", timezone: "UTC", expression: "0 9 * * 1" };
  const evening: Schedule = { kind: "weekly", timezone: "UTC", days: [1], time: "18:00" };
  const runs = upcomingRuns([morning, monday, evening], at("2026-11-01T12:00:00Z"), 4);
  assert.deepEqual(
    runs.map((r) => [iso(r.at), r.schedule]),
    [
      ["2026-11-02T09:00:00.000Z", 0],
      ["2026-11-02T18:00:00.000Z", 2],
      ["2026-11-03T09:00:00.000Z", 0],
      ["2026-11-04T09:00:00.000Z", 0],
    ],
  );
});

const A = "6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab";
const base = { name: "Nightly", prompt: "Look.", projectIds: [A] };

test("the schedule trigger needs a schedule, and triggers without it keep none", () => {
  const weekly = { kind: "weekly", timezone: "UTC", days: [1], time: "09:00" };
  const scheduled = parseAutomationInput({ ...base, triggers: ["schedule"], schedules: [weekly] }, { full: true, now: NOW });
  assert.ok(scheduled.ok);
  assert.deepEqual(scheduled.value.schedules, [weekly]);
  const none = parseAutomationInput({ ...base, triggers: ["schedule"], schedules: [] }, { full: true, now: NOW });
  assert.equal(none.ok, false);
  assert.equal(parseAutomationInput({ ...base, triggers: ["schedule"] }, { full: true, now: NOW }).ok, false);
  // Unticked: its schedules go with it.
  const off = parseAutomationInput({ triggers: ["pull_request.opened"], schedules: [weekly] }, { full: false, now: NOW });
  assert.ok(off.ok);
  assert.deepEqual(off.value.schedules, []);
  // A change of schedules alone, or a bad one.
  assert.ok(parseAutomationInput({ schedules: [weekly] }, { full: false, now: NOW }).ok);
  assert.equal(parseAutomationInput({ schedules: [{ ...weekly, days: [] }] }, { full: false, now: NOW }).ok, false);
  assert.equal(parseAutomationInput({ schedules: Array(11).fill(weekly) }, { full: false, now: NOW }).ok, false);
});

const candidate: RunCandidate = {
  automationId: "a1",
  name: "Nightly",
  prompt: "Look for flaky tests.",
  triggers: ["schedule"],
  runsAs: "u1",
  projectId: "p1",
  repoFullName: "acme/web",
  orgId: "o1",
};

const weekday: Schedule = { kind: "cron", timezone: "Europe/Berlin", expression: "0 9 * * 1-5" };

/** The tick's world: due schedules, runs recorded once per key, and
 *  schedules moved on only from the time they were due. */
function scheduleWorld(due: DueSchedule[]) {
  const keys = new Set<string>();
  const nextOf = new Map(due.map((d) => [d.scheduleId, d.dueAt as string | null]));
  const writes: RunRecord[][] = [];
  const deps: ScheduleDeps = {
    dueSchedules: async (now) => due.filter((d) => nextOf.get(d.scheduleId) && Date.parse(nextOf.get(d.scheduleId)!) <= now.getTime()),
    automationCandidates: async (ids) =>
      [candidate, { ...candidate, projectId: "p2", repoFullName: "acme/api" }].filter((c) => ids.includes(c.automationId)),
    recordRuns: async (runs) => {
      writes.push(runs);
      const made = new Map<string, string>();
      for (const run of runs) {
        const key = `${run.automationId}:${run.projectId}:${run.dedupeKey}`;
        if (keys.has(key)) continue;
        keys.add(key);
        made.set(`${run.automationId}:${run.projectId}`, `run-${run.projectId}-${run.dedupeKey}`);
      }
      return made;
    },
    advanceSchedule: async (id, from, next) => {
      if (nextOf.get(id) !== from) return false;
      nextOf.set(id, next);
      return true;
    },
  };
  return { deps, writes, nextOf };
}

test("a schedule come due runs once on each repository, then moves on to its next time", async () => {
  const dueAt = "2026-11-02T08:00:00.000Z";
  const { deps, writes, nextOf } = scheduleWorld([{ scheduleId: "s1", automationId: "a1", schedule: weekday, dueAt }]);
  const runs = await planScheduledRuns(new Date("2026-11-02T08:01:00Z"), deps);
  assert.deepEqual(
    runs.map((r) => [r.runId, r.candidate.repoFullName]),
    [
      [`run-p1-schedule:${dueAt}`, "acme/web"],
      [`run-p2-schedule:${dueAt}`, "acme/api"],
    ],
  );
  assert.deepEqual(writes[0].map((w) => [w.trigger, w.dedupeKey, w.scheduledFor]), [
    ["schedule", `schedule:${dueAt}`, dueAt],
    ["schedule", `schedule:${dueAt}`, dueAt],
  ]);
  const event = runs[0].event as ScheduleEvent;
  assert.equal(event.scheduledFor, dueAt);
  assert.equal(event.timezone, "Europe/Berlin");
  assert.equal(nextOf.get("s1"), "2026-11-03T08:00:00.000Z");
  // The next tick finds nothing due.
  assert.deepEqual(await planScheduledRuns(new Date("2026-11-02T08:03:00Z"), deps), []);
});

test("a tick sent twice, or cut off before moving the schedule on, starts nothing twice", async () => {
  const dueAt = "2026-11-02T08:00:00.000Z";
  const slot = { scheduleId: "s1", automationId: "a1", schedule: weekday, dueAt };
  const world = scheduleWorld([slot]);
  // Cut off: recorded, never moved on.
  const cutOff = { ...world.deps, advanceSchedule: async () => Promise.reject(new Error("restart")) };
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal((await planScheduledRuns(new Date("2026-11-02T08:01:00Z"), cutOff)).length, 2);
  } finally {
    console.error = originalError;
  }
  assert.equal(world.nextOf.get("s1"), dueAt);
  // The next tick records the same keys (nothing new) and moves it on.
  assert.deepEqual(await planScheduledRuns(new Date("2026-11-02T08:03:00Z"), world.deps), []);
  assert.equal(world.nextOf.get("s1"), "2026-11-03T08:00:00.000Z");
});

test("a tick that comes late runs a missed time once, then goes on from now", async () => {
  const dueAt = "2026-11-02T08:00:00.000Z";
  const { deps, nextOf } = scheduleWorld([{ scheduleId: "s1", automationId: "a1", schedule: weekday, dueAt }]);
  // Down for three days: Monday's time runs once; Tuesday's and Wednesday's don't.
  const runs = await planScheduledRuns(new Date("2026-11-05T07:00:00Z"), deps);
  assert.equal(runs.length, 2);
  assert.equal(nextOf.get("s1"), "2026-11-05T08:00:00.000Z");
});

test("two schedules of one automation due at once run once; a once is done after its run", async () => {
  const dueAt = "2026-11-02T08:00:00.000Z";
  const once: Schedule = { kind: "once", timezone: "Europe/Berlin", at: "2026-11-02T09:00" };
  const { deps, nextOf } = scheduleWorld([
    { scheduleId: "s1", automationId: "a1", schedule: weekday, dueAt },
    { scheduleId: "s2", automationId: "a1", schedule: once, dueAt },
  ]);
  const runs = await planScheduledRuns(new Date("2026-11-02T08:01:00Z"), deps);
  assert.equal(runs.length, 2);
  assert.equal(nextOf.get("s2"), null);
});

test("a schedule whose runs can't be recorded stays due for the next tick", async () => {
  const dueAt = "2026-11-02T08:00:00.000Z";
  const { deps, nextOf } = scheduleWorld([{ scheduleId: "s1", automationId: "a1", schedule: weekday, dueAt }]);
  const originalError = console.error;
  console.error = () => {};
  try {
    const failing = { ...deps, recordRuns: async () => Promise.reject(new Error("db down")) };
    assert.deepEqual(await planScheduledRuns(new Date("2026-11-02T08:01:00Z"), failing), []);
  } finally {
    console.error = originalError;
  }
  assert.equal(nextOf.get("s1"), dueAt);
  assert.equal((await planScheduledRuns(new Date("2026-11-02T08:03:00Z"), deps)).length, 2);
});

const scheduleEvent: ScheduleEvent = {
  trigger: "schedule",
  scheduledFor: "2026-11-02T08:00:00.000Z",
  timezone: "Europe/Berlin",
  description: "Cron 0 9 * * 1-5",
};

test("a scheduled run's session starts on the default branch, told when and where, and stands on its own", async () => {
  const started: ServerSessionStart[] = [];
  const deps: StartDeps = {
    orgConnector: async () => null,
    runNeighbours: async () => assert.fail("a schedule's run has no pull request"),
    archiveServerSessions: async () => assert.fail("nothing to archive"),
    startServerSession: async (start) => {
      started.push(start);
      return { workspaceId: "w1", status: "ready" };
    },
    settleRun: async () => {},
    // A pull request's review has a check; a schedule's run none.
    openCheck: async () => assert.fail("no check"),
    closeCheck: async () => assert.fail("no check"),
  };
  await startRun({ runId: "r1", candidate, event: scheduleEvent }, deps);
  assert.equal(started[0].baseBranch, undefined);
  assert.equal(started[0].title, "Nightly, Nov 2, 09:00");
  assert.match(started[0].prompt, /^Scheduled run: Cron 0 9 \* \* 1-5 \(Europe\/Berlin\), due Nov 2, 09:00\./);
  assert.match(started[0].prompt, /Repository: acme\/web/);
  // Not told a run id to mark a review with: there's no check to close.
  assert.doesNotMatch(started[0].prompt, /outrunner-run:/);
  assert.ok(started[0].prompt.endsWith("\n\nLook for flaky tests."));
  assert.equal(eventTitle("x".repeat(200), scheduleEvent).length, 120);
  assert.equal(eventPrompt("Go.", scheduleEvent, { repoFullName: "acme/web" }).split("\n").at(-1), "Go.");
});

test("a run's event is kept as it was told, and read back only when it's one", () => {
  assert.deepEqual(readRunEvent(JSON.parse(JSON.stringify(scheduleEvent))), scheduleEvent);
  assert.equal(readRunEvent(null), null);
  assert.equal(readRunEvent({ ...scheduleEvent, timezone: "Nowhere/Else" }), null);
  assert.equal(readRunEvent({ ...scheduleEvent, scheduledFor: "soon" }), null);
  assert.equal(readRunEvent({ trigger: "pull_request.opened", number: 7 }), null);
});

test("a scheduled run that failed starts again as itself, told the same time", async () => {
  const reopened: string[] = [];
  const target: RerunTarget = {
    runId: "r1",
    status: "failed",
    trigger: "schedule",
    event: scheduleEvent,
    headSha: null,
    prNumber: null,
    enabled: true,
    candidate,
    repoFullName: "acme/web",
    installationId: 42,
    installationSuspended: false,
    covered: true,
    workspaceId: "w-failed",
  };
  const deps = {
    rerunTarget: async () => target,
    pullRequest: async () => assert.fail("no pull request to read"),
    reopenRun: async (runId: string) => {
      reopened.push(runId);
      return reopened.length === 1;
    },
    recordRuns: async () => assert.fail("no new run"),
  };
  const rerun = await rerunRun("o1", "r1", deps);
  assert.ok(rerun.ok);
  assert.deepEqual(rerun.run.event, scheduleEvent);
  assert.equal(rerun.staleSession, "w-failed");
  assert.deepEqual(await rerunRun("o1", "r1", deps), { ok: false, status: 409, error: "It's running again already." });
  const lost = await rerunRun("o1", "r1", { ...deps, rerunTarget: async () => ({ ...target, event: null }) });
  assert.equal(lost.ok, false);
});
