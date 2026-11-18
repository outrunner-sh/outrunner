/** An automation's own model (20261117120000_automation_model.sql) on a
 *  disposable Postgres database. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

const server = process.env.MISSIONS_PG;
const skip = server ? false : "No local test Postgres configured";
const name = `automation_model_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const ADMIN = "00000000-0000-0000-0000-000000000001";
const MEMBER = "00000000-0000-0000-0000-000000000002";
const ORG = "00000000-0000-0000-0000-000000000011";
const REPO = "00000000-0000-0000-0000-0000000000a1";
const MIGRATIONS = [
  "20261030130000_automations.sql",
  "20261030140000_automation_runs.sql",
  "20261031180000_automation_runs_pr_index.sql",
  "20261101120000_automation_run_checks.sql",
  "20261102190000_automation_schedules.sql",
  "20261102195000_automation_webhooks.sql",
  "20261102198000_automation_limits.sql",
  "20261114140000_automation_cover_new_repos.sql",
  "20261117120000_automation_model.sql",
];
let url = "";

function psql(target: string, text: string): string {
  return execFileSync("psql", [target, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", text], { encoding: "utf8", stdio: "pipe" }).trim();
}
const sql = (text: string) => psql(url, text);

/** An automation made as the server makes one; its id. */
function automation(settings: string): string {
  return sql(
    `set role service_role; select create_automation('${ORG}', '${ADMIN}', 'A', null, 'Review.', array['pull_request.opened']::text[], true, array['${REPO}']::uuid[], '${settings}'::jsonb)`,
  );
}

/** A change as updateAutomation sends one, by `editor`, with only `settings`. */
function update(id: string, editor: string, settings: string) {
  return sql(
    `set role service_role; select update_automation('${ORG}', '${id}', '${editor}', null, null, null, null, null, '${settings}'::jsonb)`,
  );
}

const modelOf = (id: string) =>
  sql(`select concat_ws(' ', coalesce(model_provider, '-'), coalesce(model_id, '-'), coalesce(model_effort, '-'), runs_as) from automations where id = '${id}'`);

before(() => {
  if (!server) return;
  psql(server, `create database ${name}`);
  const u = new URL(server);
  u.pathname = `/${name}`;
  url = u.toString();
  sql(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create table organizations (id uuid primary key);
    create table organization_members (org_id uuid, user_id uuid, role text, primary key (org_id, user_id));
    create table projects (id uuid primary key, org_id uuid not null, owner_id uuid, github_repo_id bigint, gitlab_repo_id bigint);
    create table workspaces (id uuid primary key);
    create table organization_settings (org_id uuid primary key, archive_on_close boolean not null default true);
    do $$ declare r text; begin foreach r in array array['anon','authenticated','service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
    end loop; end $$;
    alter role service_role bypassrls;
    grant usage on schema public to authenticated, service_role;
    grant all on all tables in schema public to service_role;
    alter default privileges in schema public grant all on tables to service_role;
    insert into auth.users values ('${ADMIN}'), ('${MEMBER}');
    insert into organizations values ('${ORG}');
    insert into organization_members values ('${ORG}', '${ADMIN}', 'admin'), ('${ORG}', '${MEMBER}', 'admin');
    insert into projects (id, org_id, owner_id, github_repo_id) values ('${REPO}', '${ORG}', '${ADMIN}', 1);
  `);
  for (const file of MIGRATIONS) {
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", `supabase/migrations/${file}`], { stdio: "pipe" });
  }
  sql("grant all on all tables in schema public to service_role");
});

after(() => {
  if (server && url) psql(server, `drop database if exists ${name} with (force)`);
});

test("an automation is made with its model, or none as before", { skip }, () => {
  assert.equal(modelOf(automation(JSON.stringify({ model: { provider: "claude", id: "opus", effort: "max" } }))), `claude opus max ${ADMIN}`);
  assert.equal(modelOf(automation(JSON.stringify({ model: { provider: "outrunner", id: "z-ai/glm-5.3", effort: null } }))), `outrunner z-ai/glm-5.3 - ${ADMIN}`);
  assert.equal(modelOf(automation("{}")), `- - - ${ADMIN}`);
  assert.equal(modelOf(automation(JSON.stringify({ model: null }))), `- - - ${ADMIN}`);
  // ensure_code_review, which names none, still makes one.
  assert.notEqual(
    sql(
      `set role service_role; select coalesce(ensure_code_review('${ORG}', '${ADMIN}', 'Code Review', 'code-review', 'Review.', array['pull_request.opened']::text[], array['${REPO}']::uuid[])::text, 'none')`,
    ),
    "none",
  );
});

test("changing its model makes the editor its runner; a change without one leaves it; null clears it", { skip }, () => {
  const id = automation(JSON.stringify({ model: { provider: "claude", id: "opus", effort: "max" } }));
  // Unsent: kept, and so is the runner.
  update(id, MEMBER, JSON.stringify({ debounce_seconds: 30 }));
  assert.equal(modelOf(id), `claude opus max ${ADMIN}`);
  // The same model sent again: no change, no new runner.
  update(id, MEMBER, JSON.stringify({ model: { provider: "claude", id: "opus", effort: "max" } }));
  assert.equal(modelOf(id), `claude opus max ${ADMIN}`);
  // Another effort: whose account pays changes hands.
  update(id, MEMBER, JSON.stringify({ model: { provider: "claude", id: "opus", effort: "low" } }));
  assert.equal(modelOf(id), `claude opus low ${MEMBER}`);
  update(id, ADMIN, JSON.stringify({ model: null }));
  assert.equal(modelOf(id), `- - - ${ADMIN}`);
  // Cleared already: clearing again is no change.
  update(id, MEMBER, JSON.stringify({ model: null }));
  assert.equal(modelOf(id), `- - - ${ADMIN}`);
});

test("a model that isn't whole, or an effort that isn't a level, is refused", { skip }, () => {
  const id = automation("{}");
  for (const model of [
    { provider: "claude", effort: null },
    { id: "opus", effort: null },
    { provider: "claude", id: "opus", effort: "huge" },
    { provider: "Claude!", id: "opus" },
    { provider: "openrouter", id: "-rm" },
  ]) {
    assert.throws(() => update(id, ADMIN, JSON.stringify({ model })), /automations_model_check/, JSON.stringify(model));
  }
  assert.equal(modelOf(id), `- - - ${ADMIN}`);
});
