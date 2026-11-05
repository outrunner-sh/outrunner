/** A pull request event is recorded only on the sessions of the orgs that own
 *  the installation it came from. A project's full name is its org's members'
 *  to choose (any member can rename one), so another org's project renamed to
 *  collide with a repository must never receive its private events. */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { recordPullRequestEventWith } from "@/lib/session/pull-request-recording";

type Row = Record<string, unknown>;

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

/** The queries recordPullRequestEventWith makes, answered from the given rows.
 *  pull_requests keeps one a workspace a repository, as the table does. */
function fakeDb(tables: Record<string, Row[]>): SupabaseClient<Database> {
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

    not(column: string, operator: string, value: unknown) {
      if (operator !== "is") throw new Error(`fakeDb: .not ${operator} isn't supported`);
      this.predicates.push((row) => row[column] !== value);
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
      const project = (row: Row): Row => Object.fromEntries(this.columns.map((c) => [c, row[c]]));
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

/** Org A's installation, its repository and its session; and org B's session
 *  on a project its member renamed to collide with that repository. */
function db(withOrgBLink = false): { tables: Record<string, Row[]>; projectA: string; projectB: string; workspaceA: string; workspaceB: string; ownerA: string } {
  const projectA = "p-a";
  const projectB = "p-b";
  const workspaceA = "w-a";
  const workspaceB = "w-b";
  const ownerA = "u-a";
  return {
    projectA,
    projectB,
    workspaceA,
    workspaceB,
    ownerA,
    tables: {
      org_github_installations: [{ org_id: "org-a", installation_id: 42 }, ...(withOrgBLink ? [{ org_id: "org-b", installation_id: 42 }] : [])],
      projects: [
        { id: projectA, org_id: "org-a", full_name: "acme/private" },
        { id: projectB, org_id: "org-b", full_name: "acme/private" },
      ],
      workspaces: [
        { id: workspaceA, owner_id: ownerA, org_id: "org-a", project_id: projectA, branch: "feature/leak", status: "active", checkouts: null },
        { id: workspaceB, owner_id: "u-b", org_id: "org-b", project_id: projectB, branch: "feature/leak", status: "active", checkouts: null },
      ],
      pull_requests: [],
    },
  };
}

const event = {
  repoFullName: "acme/private",
  headRef: "feature/leak",
  baseRef: "main",
  number: 7,
  url: "https://github.com/acme/private/pull/7",
  title: "Private: the colliding org must not see this",
  state: "open" as const,
};

test("an event is recorded on the installation's own org's session, never on another org's colliding project", async () => {
  const { tables, projectA, workspaceA, ownerA } = db();
  const changed = await recordPullRequestEventWith(event, 42, fakeDb(tables));
  // Org A's session: told, and the pull request recorded on it.
  assert.deepEqual(changed, [{ workspaceId: workspaceA, ownerId: ownerA, from: null, to: "open", number: 7 }]);
  assert.deepEqual(
    tables.pull_requests.map((row) => ({ workspace_id: row.workspace_id, project_id: row.project_id, github_number: row.github_number, title: row.title })),
    [{ workspace_id: workspaceA, project_id: projectA, github_number: 7, title: event.title }],
  );
});

test("a project renamed to collide in another org receives nothing of the event", async () => {
  const { tables, projectB, workspaceB } = db();
  await recordPullRequestEventWith(event, 42, fakeDb(tables));
  // Org B's project, renamed to org A's repository's full name by one of its
  // members: no pull request of org A's private repository is recorded on it.
  assert.equal(tables.pull_requests.filter((row) => row.project_id === projectB).length, 0);
  assert.ok(tables.pull_requests.every((row) => row.workspace_id !== workspaceB));
});

test("an org the installation is shared with does receive it; an installation no org owns reaches no one", async () => {
  const shared = db(true).tables;
  const changed = await recordPullRequestEventWith(event, 42, fakeDb(shared));
  assert.equal(changed.length, 2);
  assert.ok(changed.every((c) => c.to === "open" && c.number === 7));
  // A shared installation serves both orgs' projects of the repository.
  const unclaimed = db().tables;
  assert.deepEqual(await recordPullRequestEventWith(event, 43, fakeDb(unclaimed)), []);
  assert.equal(unclaimed.pull_requests.length, 0);
});
