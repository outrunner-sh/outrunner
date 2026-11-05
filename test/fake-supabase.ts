/** A fake of the Supabase client for the query surface the webhook's
 *  installation-scoped lookups use: filters (eq, neq, in, ilike, contains,
 *  not-is/not-in), projection, maybeSingle, insert and update, answered from
 *  the rows the test gives, so the real query code runs against them. */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

export type Row = Record<string, unknown>;

/** PostgREST's ILIKE, as a regex: % is any run, _ any one character, and a
 *  backslash escapes what follows it. */
function ilike(pattern: string): RegExp {
  const escaped: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      escaped.push((pattern[i + 1] ?? "\\").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      i++;
    } else if (c === "%") escaped.push(".*");
    else if (c === "_") escaped.push(".");
    else escaped.push(c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  return new RegExp(`^${escaped.join("")}$`, "i");
}

/** jsonb containment, as the checkouts lookups use it: every object in
 *  `wanted` has a row item with all its keys equal. */
function contains(items: unknown, wanted: unknown): boolean {
  const list = Array.isArray(items) ? items : [];
  return (Array.isArray(wanted) ? wanted : [wanted]).every((w) =>
    list.some((item) =>
      w && typeof w === "object"
        ? item !== null && typeof item === "object" && Object.entries(w).every(([k, v]) => item[k as keyof object] === v)
        : item === w,
    ),
  );
}

/** The tables' rows are the fixture; pull_requests keeps one a workspace a
 *  repository, as the table does. */
export function fakeDb(tables: Record<string, Row[]>): SupabaseClient<Database> {
  let nextId = 0;
  class Query {
    table: string;
    op: "select" | "insert" | "update" = "select";
    patch: Row = {};
    single = false;
    returning = false;
    columns: string[] = [];
    predicates: Array<(row: Row) => boolean> = [];

    constructor(table: string) {
      this.table = table;
    }

    select(columns: string) {
      this.columns = columns.split(",").map((c) => c.trim());
      if (this.op === "update") this.returning = true;
      return this;
    }

    eq(column: string, value: unknown) {
      this.predicates.push((row) => row[column] === value);
      return this;
    }

    neq(column: string, value: unknown) {
      this.predicates.push((row) => row[column] !== value);
      return this;
    }

    in(column: string, values: unknown[]) {
      this.predicates.push((row) => values.includes(row[column]));
      return this;
    }

    ilike(column: string, pattern: string) {
      const re = ilike(pattern);
      this.predicates.push((row) => typeof row[column] === "string" && re.test(row[column]));
      return this;
    }

    contains(column: string, value: unknown) {
      this.predicates.push((row) => contains(row[column], value));
      return this;
    }

    not(column: string, operator: string, value: unknown) {
      if (operator === "is") this.predicates.push((row) => row[column] !== value);
      else if (operator === "in") {
        // PostgREST's in-list, as a string: "(destroyed,destroying)".
        const list = String(value).replace(/^\(|\)$/g, "").split(",").map((v) => v.trim());
        this.predicates.push((row) => !list.includes(String(row[column])));
      } else throw new Error(`fakeDb: .not ${operator} isn't supported`);
      return this;
    }

    maybeSingle() {
      this.single = true;
      return this;
    }

    insert(rows: Row | Row[]) {
      this.op = "insert";
      this.patch = { rows: Array.isArray(rows) ? rows : [rows] };
      return this;
    }

    update(patch: Row) {
      this.op = "update";
      this.patch = patch;
      return this;
    }

    then(resolve: (result: { data: unknown; error: { code?: string } | null }) => unknown) {
      const rows = tables[this.table] ?? [];
      const found = rows.filter((row) => this.predicates.every((p) => p(row)));
      const project = (row: Row): Row =>
        this.columns.includes("*") ? row : Object.fromEntries(this.columns.map((c) => [c, row[c]]));
      if (this.op === "select") {
        const projected = found.map(project);
        return Promise.resolve(resolve({ data: this.single ? projected[0] ?? null : projected, error: null }));
      }
      if (this.op === "insert") {
        const inserting = this.patch.rows as Row[];
        const clash = inserting.some((row) =>
          found.some((existing) => existing.workspace_id === row.workspace_id && existing.project_id === row.project_id),
        );
        if (this.table === "pull_requests" && clash) {
          return Promise.resolve(resolve({ data: null, error: { code: "23505" } }));
        }
        for (const row of inserting) {
          rows.push({ id: `pr_${++nextId}`, ...row });
        }
        return Promise.resolve(resolve({ data: null, error: null }));
      }
      for (const row of found) Object.assign(row, this.patch);
      return Promise.resolve(resolve({ data: this.returning ? found.map(project) : null, error: null }));
    }
  }
  return { from: (table: string) => new Query(table) } as unknown as SupabaseClient<Database>;
}
