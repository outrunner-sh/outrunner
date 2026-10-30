/** Intent-warm cleanup/wake handoff on real Postgres. CI supplies the shared
 * server; locally this is skipped unless COMPOSER_HISTORY_PG is available. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

const server = process.env.COMPOSER_HISTORY_PG;
const skip = server ? false : "COMPOSER_HISTORY_PG isn't set";
const name = `intent_warm_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const OWNER = "00000000-0000-0000-0000-00000000000a";
const PROJECT = "00000000-0000-0000-0000-00000000000b";
const WORKSPACE = "00000000-0000-0000-0000-00000000000c";
const COMPUTER = "00000000-0000-0000-0000-00000000000d";
let url = "";

function psql(target: string, sql: string): string {
  return execFileSync("psql", [target, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

function sql(text: string): string {
  return psql(url, text);
}

function asOwner(text: string): string {
  return sql(`set request.jwt.claim.sub = '${OWNER}'; ${text}`);
}

function resetWake(): void {
  sql(`
    update runtime_computers
    set pooled = true, workspace_id = null, status = 'provisioning',
        warm_expires_at = null, warm_cleanup_pending = true,
        agent_base_url = null, error_message = 'Pausing an unused session pre-warm.'
    where id = '${COMPUTER}'
  `);
}

before(() => {
  if (!server) return;
  psql(server, `create database ${name}`);
  const target = new URL(server);
  target.pathname = `/${name}`;
  url = target.toString();
  sql(`
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create type runtime_computer_status as enum ('provisioning', 'ready', 'error', 'stopped');
    create table projects (id uuid primary key, org_id uuid not null);
    create table workspaces (
      id uuid primary key, owner_id uuid not null, project_id uuid not null,
      status text not null default 'creating'
    );
    create table runtime_computers (
      id uuid primary key, owner_id uuid not null, project_id uuid not null,
      workspace_id uuid, pooled boolean not null default false,
      pool_slot integer not null default 0, generation integer,
      status runtime_computer_status not null default 'provisioning',
      provider text, daytona_sandbox_id text, agent_base_url text,
      provision_timings jsonb, warm_expires_at timestamptz,
      error_message text, last_active_at timestamptz
    );
    create function check_org_box_cap(uuid, integer) returns void language plpgsql as $$ begin return; end $$;
  `);
  sql(readFileSync("supabase/migrations/20261103210000_intent_warm_cleanup_handoff.sql", "utf8"));
  sql(`
    insert into projects values ('${PROJECT}', gen_random_uuid());
    insert into workspaces (id, owner_id, project_id) values ('${WORKSPACE}', '${OWNER}', '${PROJECT}');
    insert into runtime_computers (
      id, owner_id, project_id, pooled, status, provider, daytona_sandbox_id,
      warm_expires_at, warm_cleanup_pending
    ) values (
      '${COMPUTER}', '${OWNER}', '${PROJECT}', true, 'provisioning', 'daytona', 'sandbox-old',
      null, true
    );
  `);
});

after(() => {
  if (server) psql(server, `drop database if exists ${name} with (force)`);
});

test("pause failure before wake completion stays unclaimable until the endpoint is durable", { skip }, () => {
  resetWake();
  assert.equal(sql(`select retry_pooled_warmup_pause('${COMPUTER}', now() + interval '90 seconds')`), "f");
  assert.equal(asOwner(`select claim_pooled_computer('${WORKSPACE}', 'daytona', null)`), "");

  assert.equal(asOwner(`select complete_pooled_warmup(
    '${COMPUTER}', 'sandbox-new', 'daytona', 'https://agent.new', '{"totalMs":12}'::jsonb
  )`), "t");
  assert.equal(sql(`select status || ':' || warm_cleanup_pending || ':' || agent_base_url from runtime_computers where id = '${COMPUTER}'`), "ready:false:https://agent.new");
  assert.equal(asOwner(`select claim_pooled_computer('${WORKSPACE}', 'daytona', null)`), "sandbox-new");
});

test("wake completion during a failed pause is published only after cleanup settles", { skip }, () => {
  resetWake();
  assert.equal(asOwner(`select complete_pooled_warmup(
    '${COMPUTER}', 'sandbox-new', 'daytona', 'https://agent.new', '{"totalMs":12}'::jsonb
  )`), "f");
  assert.equal(asOwner(`select claim_pooled_computer('${WORKSPACE}', 'daytona', null)`), "");

  assert.equal(sql(`select retry_pooled_warmup_pause('${COMPUTER}', now() + interval '90 seconds')`), "t");
  assert.equal(sql(`select status || ':' || warm_cleanup_pending from runtime_computers where id = '${COMPUTER}'`), "ready:false");
  assert.equal(asOwner(`select claim_pooled_computer('${WORKSPACE}', 'daytona', null)`), "sandbox-new");
});
