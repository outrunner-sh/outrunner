import assert from "node:assert/strict";
import { test } from "node:test";

import { monthlyPeriod } from "@/lib/billing/periods";

const at = (iso: string) => new Date(iso);

test("a period runs a month from the anchor's day and time", () => {
  const anchor = at("2026-03-17T09:30:00Z");
  assert.deepEqual(monthlyPeriod(anchor, at("2026-10-20T00:00:00Z")), {
    start: at("2026-10-17T09:30:00Z"),
    end: at("2026-11-17T09:30:00Z"),
  });
  // Just before the day's time is still the previous period.
  assert.deepEqual(monthlyPeriod(anchor, at("2026-10-17T09:29:59Z")).start, at("2026-09-17T09:30:00Z"));
  assert.deepEqual(monthlyPeriod(anchor, at("2026-10-17T09:30:00Z")).start, at("2026-10-17T09:30:00Z"));
});

test("a yearly plan renews monthly, across the year end", () => {
  const anchor = at("2026-11-05T00:00:00Z");
  assert.deepEqual(monthlyPeriod(anchor, at("2027-01-10T00:00:00Z")), {
    start: at("2027-01-05T00:00:00Z"),
    end: at("2027-02-05T00:00:00Z"),
  });
});

test("anchored on the 31st, a short month's period starts on its last day", () => {
  const anchor = at("2026-01-31T00:00:00Z");
  assert.deepEqual(monthlyPeriod(anchor, at("2026-03-01T00:00:00Z")), {
    start: at("2026-02-28T00:00:00Z"),
    end: at("2026-03-31T00:00:00Z"),
  });
  assert.deepEqual(monthlyPeriod(anchor, at("2028-02-29T12:00:00Z")).start, at("2028-02-29T00:00:00Z"));
});

test("the first period starts at the anchor", () => {
  const anchor = at("2026-10-17T12:00:00Z");
  assert.deepEqual(monthlyPeriod(anchor, anchor).start, anchor);
});
