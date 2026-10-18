import assert from "node:assert/strict";
import { test } from "node:test";

import { allowancePeriod, monthlyPeriod } from "@/lib/billing/periods";

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

test("a monthly plan's period is the one Stripe bills, kept on its anchor day", () => {
  // Anchored on Jan 31: Stripe bills Feb 28 to Mar 31. Counting a month from
  // Feb 28 would renew on Mar 28, and again when Stripe moves to Mar 31.
  const february = {
    billingInterval: "month" as const,
    currentPeriodStart: at("2026-02-28T00:00:00Z"),
    currentPeriodEnd: at("2026-03-31T00:00:00Z"),
  };
  assert.deepEqual(allowancePeriod(february, at("2026-03-29T00:00:00Z")), {
    start: at("2026-02-28T00:00:00Z"),
    end: at("2026-03-31T00:00:00Z"),
  });
  // Past its end before the renewal's webhook: still that period, not a new one early.
  assert.deepEqual(allowancePeriod(february, at("2026-03-31T00:05:00Z")).start, at("2026-02-28T00:00:00Z"));
});

test("a yearly plan's months are counted from its year's start", () => {
  const year = {
    billingInterval: "year" as const,
    currentPeriodStart: at("2026-01-31T00:00:00Z"),
    currentPeriodEnd: at("2027-01-31T00:00:00Z"),
  };
  assert.deepEqual(allowancePeriod(year, at("2026-03-29T00:00:00Z")), {
    start: at("2026-02-28T00:00:00Z"),
    end: at("2026-03-31T00:00:00Z"),
  });
});
