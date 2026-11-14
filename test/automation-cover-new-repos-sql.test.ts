/** Code Review on every repository (20261114120000_automation_cover_new_repos.sql)
 *  on a disposable Postgres database. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

const server = process.env.MISSIONS_PG;
const skip = server ? false : "No local test Postgres configured";
const name = `cover_repos_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const ADMIN = "00000000-0000-0000-0000-000000000001";
const MEMBER = "00000000-0000-0000-0000-000000000002";
const ORG = "00000000-0000-0000-0000-000000000011";
const OTHER_ORG = "00000000-0000-0000-0000-000000000012";
const FRESH_ORG = "00000000-0000-0000-0000-000000000013";
const REPO_A = "00000000-0000-0000-0000-0000000000a1";
const REPO_B = "00000000-0000-0000-0000-0000000000b1";
const BEFORE = [
  "20261030130000_automations.sql",
  "20261030140000_automation_runs.sql",
  "20261031180000_automation_runs_pr_index.sql",
  "20261101120000_automation_run_checks.sql",
  "20261102190000_automation_schedules.sql",
  "20261102195000_automation_webhooks.sql",
  "20261102198000_automation_limits.sql",
];
const MIGRATION = "20261114120000_automation_cover_new_repos.sql";
let url = "";

function psql(target: string, text: string): string {
  return execFileSync("psql", [target, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", text], { encoding: "utf8", stdio: "pipe" }).trim();
}
const sql = (text: string) => psql(url, text);
const migrate = (file: string) =>
  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", `supabase/migrations/${file}`], { stdio: "pipe" });

/** An automation of `org` made as the server makes one; its id. */
function automation(org: string, template: string | null, triggers: string[], projects: string[], settings = "{}"): string {
  const list = (items: string[], type: string) => `array[${items.map((i) => `'${i}'`).join(",")}]::${type}[]`;
  return sql(
    `set role service_role; select create_automation('${org}', '${ADMIN}', 'A', ${template ? `'${template}'` : "null"}, 'Review.', ${list(triggers, "text")}, true, ${list(projects, "uuid")}, '${settings}'::jsonb)`,
  );
}

/** A project connected by a member, under their own role (as upsertProjects does). */
function connect(org: string, githubRepoId: number | null, id = randomUUID()): string {
  sql(
    `set role authenticated; insert into projects (id, org_id, owner_id, github_repo_id, gitlab_repo_id) values ('${id}', '${org}', '${MEMBER}', ${githubRepoId ?? "null"}, ${githubRepoId === null ? 7 : "null"})`,
  );
  return id;
}

const reposOf = (automationId: string) =>
  sql(`select coalesce(string_agg(project_id::text, ',' order by project_id), '') from automation_repos where automation_id = '${automationId}'`);

let reviewOnEvents = "";
let reviewOnSchedule = "";
let otherTemplate = "";

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
    -- As Supabase's: the server's role passes row-level security.
    alter role service_role bypassrls;
    grant usage on schema public to authenticated, service_role;
    grant select, insert, update on projects to authenticated;
    grant all on all tables in schema public to service_role;
    alter default privileges in schema public grant all on tables to service_role;
    insert into auth.users values ('${ADMIN}'), ('${MEMBER}');
    insert into organizations values ('${ORG}'), ('${OTHER_ORG}'), ('${FRESH_ORG}');
    insert into organization_members values ('${ORG}', '${ADMIN}', 'admin'), ('${ORG}', '${MEMBER}', 'member'),
      ('${OTHER_ORG}', '${ADMIN}', 'admin'), ('${FRESH_ORG}', '${MEMBER}', 'admin');
    insert into projects (id, org_id, owner_id, github_repo_id) values
      ('${REPO_A}', '${ORG}', '${ADMIN}', 1), ('${REPO_B}', '${ORG}', '${ADMIN}', 2);
  `);
  for (const file of BEFORE) migrate(file);
  sql("grant all on all tables in schema public to service_role");
  // Made before the migration: it decides which of them cover new repositories.
  reviewOnEvents = automation(ORG, "code-review", ["pull_request.opened", "pull_request.synchronize"], [REPO_A]);
  reviewOnSchedule = automation(
    ORG,
    "code-review",
    ["pull_request.opened", "schedule"],
    [REPO_A],
    JSON.stringify({ schedules: [{ kind: "cron", timezone: "UTC", spec: { expression: "0 9 * * 1" }, next_run_at: null }] }),
  );
  otherTemplate = automation(ORG, "validate-acceptance", ["pull_request.opened"], [REPO_A]);
  migrate(MIGRATION);
  sql("grant all on all tables in schema public to service_role");
});

after(() => {
  if (server && url) psql(server, `drop database if exists ${name} with (force)`);
});

test("Code Review automations already made cover new repositories, unless a schedule or webhook starts them", { skip }, () => {
  assert.equal(sql(`select cover_new_repos from automations where id = '${reviewOnEvents}'`), "t");
  assert.equal(sql(`select cover_new_repos from automations where id = '${reviewOnSchedule}'`), "f");
  assert.equal(sql(`select cover_new_repos from automations where id = '${otherTemplate}'`), "f");
});

test("a GitHub repository a member connects joins the org's covering automations, and no one else's", { skip }, () => {
  const elsewhere = automation(OTHER_ORG, "code-review", ["pull_request.opened"], [], JSON.stringify({ cover_new_repos: true }));
  const added = connect(ORG, 3);
  assert.ok(reposOf(reviewOnEvents).split(",").includes(added));
  assert.ok(!reposOf(reviewOnSchedule).split(",").includes(added));
  assert.ok(!reposOf(otherTemplate).split(",").includes(added));
  assert.equal(reposOf(elsewhere), "");
  // A GitLab project: automations run on GitHub's events alone.
  const gitlab = connect(ORG, null);
  assert.ok(!reposOf(reviewOnEvents).split(",").includes(gitlab));
});

test("a repository taken off stays off when it's connected again", { skip }, () => {
  const repo = connect(ORG, 4);
  assert.ok(reposOf(reviewOnEvents).split(",").includes(repo));
  const kept = reposOf(reviewOnEvents).split(",").filter((id) => id !== repo);
  sql(
    `set role service_role; select update_automation('${ORG}', '${reviewOnEvents}', '${ADMIN}', null, null, null, null, array[${kept.map((id) => `'${id}'`).join(",")}]::uuid[], '{}'::jsonb)`,
  );
  // A sync upserts every repository again: an update, which adds nothing.
  sql(
    `set role authenticated; insert into projects (id, org_id, owner_id, github_repo_id) values ('${repo}', '${ORG}', '${MEMBER}', 4) on conflict (id) do update set github_repo_id = excluded.github_repo_id`,
  );
  assert.ok(!reposOf(reviewOnEvents).split(",").includes(repo));
});

test("covering new repositories is refused with a trigger that runs on all of them, and changing it changes the runner", { skip }, () => {
  assert.throws(
    () =>
      sql(
        `set role service_role; select update_automation('${ORG}', '${reviewOnEvents}', '${ADMIN}', null, null, array['pull_request.opened', 'webhook']::text[], null, null, '{}'::jsonb)`,
      ),
    /automations_cover_new_repos_check/,
  );
  sql(
    `set role service_role; select update_automation('${ORG}', '${reviewOnEvents}', '${MEMBER}', null, null, null, null, null, '{"cover_new_repos": false}'::jsonb)`,
  );
  assert.equal(sql(`select cover_new_repos || ' ' || runs_as from automations where id = '${reviewOnEvents}'`), `false ${MEMBER}`);
});

test("ensure_code_review makes an org's Code Review once, and never over one an admin made or turned off", { skip }, () => {
  const ensure = (org: string, projects: string[]) =>
    sql(
      `set role service_role; select coalesce(ensure_code_review('${org}', '${MEMBER}', 'Code Review', 'code-review', 'Review.', array['pull_request.opened', 'pull_request.synchronize']::text[], array[${projects.map((p) => `'${p}'`).join(",")}]::uuid[])::text, 'none')`,
    );
  const repo = connect(FRESH_ORG, 5);
  const made = ensure(FRESH_ORG, [repo]);
  assert.notEqual(made, "none");
  assert.equal(
    sql(`select template || ' ' || enabled || ' ' || cover_new_repos || ' ' || runs_as from automations where id = '${made}'`),
    `code-review true true ${MEMBER}`,
  );
  assert.equal(reposOf(made), repo);
  assert.equal(ensure(FRESH_ORG, [repo]), "none");
  // ORG has its own already (one off, one not covering): left as they are.
  assert.equal(ensure(ORG, [REPO_B]), "none");
  assert.equal(sql(`select count(*) from automations where org_id = '${ORG}' and template = 'code-review'`), "2");
  // The next repository connected joins it.
  const next = connect(FRESH_ORG, 6);
  assert.ok(reposOf(made).split(",").includes(next));
});
