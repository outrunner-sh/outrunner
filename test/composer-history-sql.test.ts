/** The composer migrations on Postgres, including the unrelated legacy table
 *  present in production. CI provides COMPOSER_HISTORY_PG; each test creates
 *  and removes a database of its own, never using the server database's tables. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const server = process.env.COMPOSER_HISTORY_PG;
const skip = server ? false : "COMPOSER_HISTORY_PG isn't set";
const original = readFileSync("supabase/migrations/20261102230000_prompt_history.sql", "utf8");
const additive = readFileSync("supabase/migrations/20261102270000_composer_prompt_history.sql", "utf8");
const OWNER = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";

function psql(url: string, sql: string): string {
  return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8", stdio: "pipe" }).trim();
}

function database(check: (sql: (text: string) => string, as: (owner: string, text: string) => string) => void): void {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const name = `composer_history_${suffix}`;
  const role = `history_user_${suffix}`;
  const url = new URL(server!);
  url.pathname = `/${name}`;
  const sql = (text: string) => psql(url.toString(), text);
  psql(server!, `create database ${name}`);
  try {
    sql(`
      create role ${role} nologin;
      create schema auth;
      create table auth.users (id uuid primary key);
      insert into auth.users values ('${OWNER}'), ('${OTHER}');
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema public, auth to ${role};
      alter default privileges in schema public grant select, insert, update, delete on tables to ${role};
      alter default privileges in schema public grant usage on sequences to ${role};
    `);
    check(sql, (owner, text) => sql(`set role ${role}; set request.jwt.claim.sub = '${owner}'; ${text}`));
  } finally {
    psql(server!, `drop database ${name} with (force)`);
    psql(server!, `drop role if exists ${role}`);
  }
}

/** Schema, permissions and data: compare before/after so a rename, added
 *  column, changed policy or dropped/recreated table cannot pass unnoticed. */
const legacySnapshot = `
  select jsonb_build_object(
    'oid', c.oid, 'owner', c.relowner, 'acl', c.relacl, 'rls', c.relrowsecurity,
    'columns', (select jsonb_agg(jsonb_build_array(a.attname, a.atttypid, a.atttypmod, a.attnotnull) order by a.attnum)
      from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
    'constraints', (select jsonb_agg(pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid = c.oid),
    'indexes', (select jsonb_agg(indexdef order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'prompt_history'),
    'policies', (select jsonb_agg(to_jsonb(p) order by policyname) from pg_policies p where schemaname = 'public' and tablename = 'prompt_history'),
    'rows', (select jsonb_agg(to_jsonb(h) order by id) from public.prompt_history h)
  ) from pg_class c where c.oid = 'public.prompt_history'::regclass;
`;

test("the unapplied migration preserves production's legacy prompt history", { skip }, () => database((sql) => {
  sql(`
    create table public.prompt_history (
      id uuid primary key, prompt_id uuid, parent_id uuid, snapshot jsonb,
      user_id uuid, commit_message text, created_at bigint
    );
    create index legacy_history_user on public.prompt_history (user_id);
    alter table public.prompt_history enable row level security;
    create policy legacy_history_owner on public.prompt_history using (user_id = auth.uid());
    insert into public.prompt_history values (
      '${OWNER}', '${OTHER}', null, '{"legacy":true}', '${OWNER}', 'keep this', 1793232000000
    );
  `);
  const before = sql(legacySnapshot);
  // The pending version must succeed by itself, before the additive version.
  sql(`begin; ${original} commit;`);
  sql(`insert into public.composer_prompt_history (owner_id, text) values ('${OWNER}', 'recall this')`);
  sql(`begin; ${additive} commit;`);
  assert.equal(sql(legacySnapshot), before);
  assert.equal(sql("select text from public.composer_prompt_history"), "recall this");
}));

test("clean installs can apply both migrations repeatedly without losing composer history", { skip }, () => database((sql) => {
  sql(`begin; ${original} ${additive} commit;`);
  sql(`insert into public.composer_prompt_history (owner_id, text) values ('${OWNER}', 'first')`);
  sql(`begin; ${original} ${additive} commit;`);
  assert.equal(sql("select text from public.composer_prompt_history"), "first");
  assert.equal(sql("select to_regclass('public.prompt_history') is null"), "t", "no legacy table is created");
}));

test("the additive migration supports installations that already recorded the old version", { skip }, () => database((sql) => {
  // The original #264 schema on an installation where that version succeeded.
  sql(`
    create table public.prompt_history (
      id bigint generated always as identity primary key,
      owner_id uuid not null references auth.users(id) on delete cascade,
      text text not null check (char_length(text) between 1 and 20000),
      created_at timestamptz not null default now()
    );
    insert into public.prompt_history (owner_id, text) values ('${OWNER}', 'leave this table alone');
  `);
  const before = sql(legacySnapshot);
  // The recorded version is skipped: only the new version runs.
  sql(`begin; ${additive} commit;`);
  assert.equal(sql(legacySnapshot), before);
  assert.equal(sql("select count(*) from public.composer_prompt_history"), "0");
  sql(`insert into public.composer_prompt_history (owner_id, text) values ('${OWNER}', 'new recall')`);
  assert.equal(sql("select text from public.composer_prompt_history"), "new recall");
}));

test("composer history isolates owners for reads, writes and pruning", { skip }, () => database((sql, as) => {
  sql(original);
  as(OWNER, `insert into public.composer_prompt_history (owner_id, text) values ('${OWNER}', 'first')`);
  as(OTHER, `insert into public.composer_prompt_history (owner_id, text) values ('${OTHER}', 'private')`);
  as(OWNER, `insert into public.composer_prompt_history (owner_id, text) values ('${OWNER}', 'second')`);
  assert.equal(as(OWNER, "select text from public.composer_prompt_history order by id desc"), "second\nfirst");
  assert.throws(() => as(OWNER, `insert into public.composer_prompt_history (owner_id, text) values ('${OTHER}', 'spoof')`));
  assert.throws(() => as(OWNER, `insert into public.composer_prompt_history (owner_id, text) values ('${OWNER}', '')`));
  assert.throws(() => as(OWNER, `update public.composer_prompt_history set owner_id = '${OTHER}' where text = 'second'`));
  as(OWNER, `update public.composer_prompt_history set text = 'overwrite' where owner_id = '${OTHER}'`);
  as(OWNER, "delete from public.composer_prompt_history where id <= 2");
  assert.equal(as(OTHER, "select text from public.composer_prompt_history"), "private");
  assert.equal(as(OWNER, "select text from public.composer_prompt_history"), "second");
  sql(`delete from auth.users where id = '${OWNER}'`);
  assert.equal(sql(`select count(*) from public.composer_prompt_history where owner_id = '${OWNER}'`), "0");
  assert.equal(sql("select count(*) from public.composer_prompt_history"), "1");
}));
