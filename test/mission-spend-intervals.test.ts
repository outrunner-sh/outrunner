/** A Mission family's compute intervals are read as the org's are: open ones,
 *  and closed ones bounded below by LONGEST_INTERVAL_MS before the period, so
 *  the (computer_id, started_at) index never walks a box's whole history. The
 *  intervals found are the ones the single unbounded read found. */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { LONGEST_INTERVAL_MS } from "@/lib/billing/reconcile";
import { familyIntervalsWith } from "@/lib/missions/spend-intervals";
import type { Database } from "@/lib/supabase/database.types";

type Row = Record<string, unknown>;
type Filter = { op: string; column: string; value: unknown };
type Read = { table: string; filters: Filter[] };

const time = (v: unknown) => Date.parse(String(v));

/** Answers the query surface the read uses from `tables`, recording each
 *  read's filters; `afterRead` runs once a read is answered. */
function fakeDb(tables: Record<string, Row[]>, afterRead: (read: Read) => void = () => {}) {
  const reads: Read[] = [];
  class Query {
    read: Read;
    columns: string[] = [];
    window: [number, number] | null = null;
    constructor(table: string) {
      this.read = { table, filters: [] };
    }
    filter(op: string, column: string, value: unknown) {
      this.read.filters.push({ op, column, value });
      return this;
    }
    select(columns: string) {
      this.columns = columns.split(",").map((c) => c.trim());
      return this;
    }
    in(column: string, values: unknown[]) {
      return this.filter("in", column, values);
    }
    lt(column: string, value: string) {
      return this.filter("lt", column, value);
    }
    gt(column: string, value: string) {
      return this.filter("gt", column, value);
    }
    gte(column: string, value: string) {
      return this.filter("gte", column, value);
    }
    is(column: string, value: null) {
      return this.filter("is", column, value);
    }
    not(column: string, operator: string, value: null) {
      assert.equal(operator, "is");
      return this.filter("not.is", column, value);
    }
    or(filter: string) {
      return this.filter("or", "", filter);
    }
    order() {
      return this;
    }
    range(from: number, to: number) {
      this.window = [from, to];
      return this;
    }
    matches(row: Row): boolean {
      return this.read.filters.every(({ op, column, value }) => {
        const v = row[column];
        if (op === "in") return (value as unknown[]).includes(v);
        if (op === "lt") return time(v) < time(value);
        if (op === "gt") return v !== null && time(v) > time(value);
        if (op === "gte") return time(v) >= time(value);
        if (op === "is") return v === null;
        if (op === "not.is") return v !== null;
        throw new Error(`fake: ${op} isn't supported`);
      });
    }
    then(resolve: (result: { data: Row[]; error: null }) => unknown) {
      const found = (tables[this.read.table] ?? []).filter((row) => this.matches(row)).map((row) => ({ ...row }));
      const page = this.window ? found.slice(this.window[0], this.window[1] + 1) : found;
      const data = page.map((row) => Object.fromEntries(this.columns.map((c) => [c, row[c]])));
      reads.push(this.read);
      afterRead(this.read);
      return Promise.resolve(resolve({ data, error: null }));
    }
  }
  const client = { from: (table: string) => new Query(table) } as unknown as SupabaseClient<Database>;
  return { client, reads };
}

const HOUR = 60 * 60_000;
const period = { start: new Date("2026-11-12T00:00:00Z"), end: new Date("2026-11-13T00:00:00Z") };
const at = (ms: number) => new Date(period.start.getTime() + ms).toISOString();

function interval(id: string, startMs: number, endMs: number | null, computer = "c-1"): Row {
  return {
    id,
    computer_id: computer,
    sandbox_id: `sb-${computer}`,
    cpu: "2",
    started_at: at(startMs),
    last_seen_at: at(endMs ?? startMs + HOUR),
    ended_at: endMs === null ? null : at(endMs),
  };
}

const computers = [
  { id: "c-1", workspace_id: "mission" },
  { id: "c-2", workspace_id: "ship" },
  { id: "c-other", workspace_id: "someone-else" },
];

/** What the single `.or()` read matched: started before the period's end,
 *  and open or ended after its start. */
function previously(rows: Row[], family: string[]): string[] {
  return rows
    .filter((r) => family.includes(String(r.computer_id)))
    .filter((r) => time(r.started_at) < period.end.getTime())
    .filter((r) => r.ended_at === null || time(r.ended_at) > period.start.getTime())
    .map((r) => String(r.id))
    .sort();
}

const ids = (rows: { startedAt: Date }[], all: Row[]) =>
  rows.map((r) => String(all.find((row) => time(row.started_at) === r.startedAt.getTime())!.id)).sort();

test("every interval read is bounded below on the index: open ones, or closed ones from LONGEST_INTERVAL_MS before the period", async () => {
  const { client, reads } = fakeDb({ runtime_computers: computers, compute_intervals: [interval("a", -2 * HOUR, HOUR)] });
  await familyIntervalsWith(client, ["mission", "ship"], period);
  const intervalReads = reads.filter((r) => r.table === "compute_intervals");
  assert.equal(intervalReads.length, 2);
  const floor = new Date(period.start.getTime() - LONGEST_INTERVAL_MS).toISOString();
  for (const read of intervalReads) {
    assert.ok(!read.filters.some((f) => f.op === "or"), "no .or(): it can't bound the closed ones below");
    assert.deepEqual(read.filters.find((f) => f.op === "lt"), { op: "lt", column: "started_at", value: period.end.toISOString() });
    const open = read.filters.some((f) => f.op === "is" && f.column === "ended_at");
    const bounded = read.filters.some((f) => f.op === "gte" && f.column === "started_at" && f.value === floor);
    assert.ok(open !== bounded, "a read is either the open one or the bounded closed one");
  }
});

test("a closed interval long before the period is never read; what is found is what the single read found", async () => {
  const rows = [
    interval("ancient", -30 * 24 * HOUR, -30 * 24 * HOUR + HOUR),
    interval("ended-before", -5 * HOUR, -HOUR),
    interval("crosses-start", -3 * HOUR, 2 * HOUR),
    interval("ends-at-start", -2 * HOUR, 0),
    interval("inside", 4 * HOUR, 6 * HOUR, "c-2"),
    interval("crosses-end", 20 * HOUR, 28 * HOUR, "c-2"),
    interval("after", 25 * HOUR, 26 * HOUR, "c-2"),
    interval("open-old", -10 * 24 * HOUR, null),
    interval("someone-elses", -HOUR, HOUR, "c-other"),
  ];
  const { client, reads } = fakeDb({ runtime_computers: computers, compute_intervals: rows });
  const found = await familyIntervalsWith(client, ["mission", "ship"], period);

  assert.deepEqual(ids(found, rows), previously(rows, ["c-1", "c-2"]));
  assert.deepEqual(ids(found, rows), ["crosses-end", "crosses-start", "inside", "open-old"].sort());

  // Not just filtered out after: the closed read's started_at range, which
  // the index walks, doesn't reach it.
  const closedRead = reads.find((r) => r.filters.some((f) => f.op === "gte"))!;
  const floor = time(closedRead.filters.find((f) => f.op === "gte")!.value);
  assert.ok(time(rows[0].started_at) < floor);
  assert.ok(time(rows[2].started_at) >= floor, "one crossing the start is in range");

  const crossing = found.find((r) => r.startedAt.getTime() === time(rows[2].started_at))!;
  assert.deepEqual(crossing, {
    sandboxId: "sb-c-1",
    cpu: 2,
    startedAt: new Date(at(-3 * HOUR)),
    lastSeenAt: new Date(at(2 * HOUR)),
    endedAt: new Date(at(2 * HOUR)),
  });
});

test("an interval closed between the two reads is counted once, as closed", async () => {
  const rows = [interval("closing", -HOUR, null)];
  let closed = false;
  const { client } = fakeDb({ runtime_computers: computers, compute_intervals: rows }, (read) => {
    if (closed || !read.filters.some((f) => f.op === "is")) return;
    closed = true;
    rows[0].ended_at = at(3 * HOUR);
    rows[0].last_seen_at = at(3 * HOUR);
  });
  const found = await familyIntervalsWith(client, ["mission"], period);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].endedAt, new Date(at(3 * HOUR)));
});

test("a family with no boxes reads no intervals", async () => {
  const { client, reads } = fakeDb({ runtime_computers: computers, compute_intervals: [] });
  assert.deepEqual(await familyIntervalsWith(client, ["nobody"], period), []);
  assert.ok(!reads.some((r) => r.table === "compute_intervals"));
});
