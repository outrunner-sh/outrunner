import assert from "node:assert/strict";
import { test } from "node:test";

import { calendarMonth, hoursUsed, type Interval, OPEN_GRACE_MS } from "@/lib/billing/hours";

const at = (iso: string) => new Date(iso);
const october = calendarMonth(at("2026-10-17T12:00:00Z"));
const now = at("2026-10-17T12:00:00Z");

function run(sandboxId: string, start: string, end: string | null, opts: { cpu?: number; seen?: string } = {}): Interval {
  return {
    sandboxId,
    cpu: opts.cpu ?? 2,
    startedAt: at(start),
    lastSeenAt: at(opts.seen ?? end ?? start),
    endedAt: end ? at(end) : null,
  };
}

test("the Free period is the calendar month, in UTC", () => {
  assert.deepEqual(october, { start: at("2026-10-01T00:00:00Z"), end: at("2026-11-01T00:00:00Z") });
  assert.deepEqual(calendarMonth(at("2026-12-31T23:59:59Z")).end, at("2027-01-01T00:00:00Z"));
});

test("hours count in Small-box hours: Medium double, X Small half", () => {
  assert.equal(hoursUsed([run("a", "2026-10-02T10:00:00Z", "2026-10-02T12:00:00Z")], october, now), 2);
  assert.equal(hoursUsed([run("b", "2026-10-02T10:00:00Z", "2026-10-02T11:00:00Z", { cpu: 4 })], october, now), 2);
  assert.equal(hoursUsed([run("c", "2026-10-02T10:00:00Z", "2026-10-02T11:00:00Z", { cpu: 1 })], october, now), 0.5);
});

test("only the part inside the period counts", () => {
  // Across the month's start: 1h in September, 2h in October.
  const across = run("a", "2026-09-30T23:00:00Z", "2026-10-01T02:00:00Z");
  assert.equal(hoursUsed([across], october, now), 2);
  assert.equal(hoursUsed([run("b", "2026-09-10T00:00:00Z", "2026-09-10T05:00:00Z")], october, now), 0);
});

test("two boxes at once both count; one box's overlapping intervals count once", () => {
  const twoBoxes = [run("a", "2026-10-02T10:00:00Z", "2026-10-02T11:00:00Z"), run("b", "2026-10-02T10:00:00Z", "2026-10-02T11:00:00Z")];
  assert.equal(hoursUsed(twoBoxes, october, now), 2);
  const sameBox = [
    run("a", "2026-10-02T10:00:00Z", "2026-10-02T11:00:00Z"),
    run("a", "2026-10-02T10:30:00Z", "2026-10-02T11:30:00Z"),
    run("a", "2026-10-02T10:40:00Z", "2026-10-02T10:50:00Z"),
  ];
  assert.equal(hoursUsed(sameBox, october, now), 1.5);
});

test("a running box counts to now while it's being seen", () => {
  const running = run("a", "2026-10-17T11:00:00Z", null, { seen: "2026-10-17T11:59:00Z" });
  assert.equal(hoursUsed([running], october, now), 1);
});

test("a box not seen for a while counts to its last sighting, not to now", () => {
  // Stopped unseen (crashed, or the reconciler was down): the user isn't
  // charged for time no one saw it run, past a short grace.
  const stale = run("a", "2026-10-17T09:00:00Z", null, { seen: "2026-10-17T10:00:00Z" });
  const graceHours = OPEN_GRACE_MS / 3_600_000;
  assert.equal(hoursUsed([stale], october, now), 1 + graceHours);
});

test("nothing counts from the future, and a backwards interval counts nothing", () => {
  assert.equal(hoursUsed([run("a", "2026-10-17T11:00:00Z", "2026-10-17T14:00:00Z")], october, now), 1);
  assert.equal(hoursUsed([run("b", "2026-10-17T11:00:00Z", "2026-10-17T10:00:00Z")], october, now), 0);
  assert.equal(hoursUsed([], october, now), 0);
});
