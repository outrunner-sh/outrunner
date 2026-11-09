import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { SOURCE_LABELS, trackerOwned, WORK_ITEM_SOURCES } from "@/lib/triage/work-items";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const migration = read("supabase/migrations/20261108120000_trackers.sql");
const TABLES = [
  "tracker_installations",
  "org_tracker_installations",
  "tracker_scopes",
  "tracker_rules",
  "tracker_links",
  "tracker_events_seen",
];

test("every tracker table is the server's alone: RLS on, no policy, every grant revoked", () => {
  for (const table of TABLES) {
    assert.match(migration, new RegExp(`alter table ${table} enable row level security;`), table);
    assert.match(migration, new RegExp(`revoke all on table ${table} from anon, authenticated;`), table);
  }
  assert.doesNotMatch(migration, /create policy/i);
});

test("the migration only adds, so the code can deploy before or after it", () => {
  assert.doesNotMatch(migration, /\bdrop (table|column|type)\b/i);
  assert.doesNotMatch(migration, /alter column/i);
  assert.doesNotMatch(migration, /\brename\b/i);
  // A column added to a table that already has rows can't demand a value.
  for (const added of migration.matchAll(/alter table (\w+) add column[^;]*;/g)) {
    assert.doesNotMatch(added[0], /not null/i, added[1]);
  }
});

test("a team is one org's, and a rule's and a default's project is that org's", () => {
  assert.match(migration, /tracker_scopes_team_unique unique \(installation_id, external_team_id\)/);
  assert.match(migration, /foreign key \(org_id, default_project_id\)\s+references projects \(org_id, id\) on delete set null \(default_project_id\)/);
  assert.match(migration, /foreign key \(org_id, project_id\)\s+references projects \(org_id, id\) on delete set null \(project_id\)/);
});

test("rule-started sessions are off by default, and capped", () => {
  assert.match(migration, /accept_rule_sessions boolean not null default false/);
  assert.match(migration, /rule_sessions_per_day integer not null default 20 check \(rule_sessions_per_day between 1 and 500\)/);
});

test("each rule filter is capped in the database too", () => {
  for (const filter of ["labels", "states", "priorities", "issue_types", "assignees"]) {
    assert.match(migration, new RegExp(`${filter} text\\[\\] not null default '\\{\\}' check \\(cardinality\\(${filter}\\) <= 20\\)`), filter);
  }
});

test("the database types know the new tables and columns", () => {
  const types = read("lib/supabase/database.types.ts");
  for (const table of TABLES) assert.match(types, new RegExp(`\\b${table}: \\{`), table);
  assert.match(types, /WorkItemSourceDb = [^;]*"linear" \| "jira"/);
  assert.match(types, /source_author: string \| null;/);
});

test("the cron calls the trackers' tick, and passes the Linear app's secrets on", () => {
  const worker = read("cloudflare/worker.ts");
  assert.match(worker, /call\("\/api\/integrations\/trackers\/tick"/);
  for (const secret of ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_WEBHOOK_SECRET", "JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET"]) {
    assert.match(worker, new RegExp(`env\\.${secret} \\? \\{ ${secret}: env\\.${secret} \\}`), secret);
  }
});

test("the webhook route reads raw bytes, so the signature is over the body as it came", () => {
  const route = read("app/api/integrations/linear/webhook/route.ts");
  assert.match(route, /request\.arrayBuffer\(\)/);
  assert.doesNotMatch(route, /request\.json\(\)/);
});

test("the workspace's team list is an admin's, and a team's catalog any member's", () => {
  const teams = read("app/api/orgs/[id]/trackers/[installationId]/teams/route.ts");
  for (const handler of teams.split("export async function ").slice(1)) {
    assert.match(handler, /orgCaller\(request, id, \{ admin: true \}\)/, handler.slice(0, 10));
  }
  const scope = read("app/api/orgs/[id]/trackers/scopes/[scopeId]/route.ts");
  assert.match(scope.slice(scope.indexOf("export async function GET")), /orgCaller\(request, id, \{ admin: false \}\)/);
});

test("Linear and Jira are sources an item can have, with a label", () => {
  for (const source of ["linear", "jira"] as const) {
    assert.ok(WORK_ITEM_SOURCES.includes(source));
    assert.ok(SOURCE_LABELS[source]);
  }
});

test("a tracker owns the title and body of an item that follows it, and only those", () => {
  assert.equal(trackerOwned({ source: "linear", sourceRef: "linear:1" }), true);
  assert.equal(trackerOwned({ source: "jira", sourceRef: "jira:c/1" }), true);
  // It moved out of reach: the item is the org's own now.
  assert.equal(trackerOwned({ source: "linear", sourceRef: null }), false);
  assert.equal(trackerOwned({ source: "slack", sourceRef: "slack:t/c/1" }), false);
  assert.equal(trackerOwned({ source: "api", sourceRef: "linear:1" }), false);
});
