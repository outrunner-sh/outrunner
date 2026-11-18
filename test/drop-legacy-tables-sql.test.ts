/** Dropping the legacy app's tables (20261118100000), on a real Postgres: a
 *  no-op on a fresh install, every legacy table gone from a production-shaped
 *  database with Outrunner's own tables untouched, and nothing dropped when
 *  something outside the legacy set depends on them. Needs MISSIONS_PG (as
 *  CI sets it); each test makes and removes a database of its own. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const server = process.env.MISSIONS_PG;
const skip = server ? false : "MISSIONS_PG isn't set";
const lock = readFileSync("supabase/migrations/20261104130000_lock_legacy_public_tables.sql", "utf8");
const drop = readFileSync("supabase/migrations/20261118100000_drop_legacy_public_tables.sql", "utf8");

/** The 43 names #387 locked, from its migration. */
const LEGACY = [...lock.match(/foreach t in array array\[([\s\S]*?)\]/)![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

function psql(url: string, sql: string): string {
  return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8", stdio: "pipe" }).trim();
}

function database(check: (sql: (text: string) => string) => void): void {
  const name = `legacy_drop_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const url = new URL(server!);
  url.pathname = `/${name}`;
  const sql = (text: string) => psql(url.toString(), text);
  psql(server!, `create database ${name}`);
  try {
    sql(`
      do $$ declare r text; begin
        foreach r in array array['anon', 'authenticated', 'service_role'] loop
          begin execute format('create role %I nologin', r); exception when duplicate_object then null; end;
        end loop;
      end $$;
      create schema auth;
      create table auth.users (id uuid primary key);
      -- Outrunner's own tables, some with names close to the legacy ones.
      create table public.memories (id int primary key, body text);
      create table public.automations (id int primary key, name text);
      create table public.composer_prompt_history (id int primary key, owner_id uuid references auth.users (id), text text);
      insert into public.memories values (1, 'keep');
      insert into public.automations values (1, 'keep');
    `);
    check(sql);
  } finally {
    psql(server!, `drop database ${name} with (force)`);
  }
}

/** The production shape: every legacy table, with foreign keys among them, locked by #387. */
const PRODUCTION = `
  ${LEGACY.map((t) => `create table public."${t}" (id text primary key, data text); insert into public."${t}" values ('1', 'legacy');`).join("\n")}
  alter table public.chat_message add column chat_id text references public.chat (id);
  alter table public.group_member add column group_id text references public."group" (id);
  alter table public."auth" add column user_id text references public."user" (id) on delete cascade;
  alter table public.calendar_event_attendee add column event_id text references public.calendar_event (id);
  ${lock}
`;

const remaining = (sql: (text: string) => string) =>
  sql(`select string_agg(t, ',' order by t) from unnest(array[${LEGACY.map((t) => `'${t}'`).join(",")}]) t where to_regclass(format('public.%I', t)) is not null`);

const outrunnerIntact = (sql: (text: string) => string) => {
  assert.equal(sql("select body from public.memories"), "keep");
  assert.equal(sql("select name from public.automations"), "keep");
  assert.equal(sql("select to_regclass('public.composer_prompt_history') is not null and to_regclass('auth.users') is not null"), "t");
};

test("the drop migration covers exactly the 43 tables #387 locked", () => {
  assert.equal(LEGACY.length, 43);
  const dropped = [...drop.matchAll(/drop table if exists public\."([a-z_]+)" cascade;/g)].map((m) => m[1]);
  assert.deepEqual([...dropped].sort(), [...LEGACY].sort());
  const guarded = [...drop.match(/c\.relname = any \(array\[([\s\S]*?)\]\)/)![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...guarded].sort(), [...LEGACY].sort());
});

test("a fresh install applies it, twice, as a no-op", { skip }, () => database((sql) => {
  sql(`begin; ${lock} ${drop} commit;`);
  sql(`begin; ${drop} commit;`);
  assert.equal(remaining(sql), "");
  outrunnerIntact(sql);
}));

test("production's legacy tables are all dropped, and only they", { skip }, () => database((sql) => {
  sql(PRODUCTION);
  assert.equal(remaining(sql).split(",").length, 43);
  sql(`begin; ${drop} commit;`);
  assert.equal(remaining(sql), "");
  outrunnerIntact(sql);
  // Applying it again changes nothing.
  sql(`begin; ${drop} commit;`);
  outrunnerIntact(sql);
}));

test("Outrunner's earlier prompt_history (owner_id, text) is kept", { skip }, () => database((sql) => {
  sql(`
    create table public.prompt_history (id bigint primary key, owner_id uuid references auth.users (id), text text, created_at timestamptz);
    insert into public.prompt_history values (1, null, 'old recall', now());
  `);
  sql(`begin; ${drop} commit;`);
  assert.equal(sql("select text from public.prompt_history"), "old recall");
}));

for (const [what, outside, named] of [
  ["a view", `create view public.outrunner_users as select id from public."user";`, /view outrunner_users/],
  ["a foreign key", `create table public.outrunner_links (chat_id text references public.chat (id));`, /constraint outrunner_links_chat_id_fkey/],
  ["a policy", `create table public.outrunner_guarded (id int); alter table public.outrunner_guarded enable row level security;
     create policy outrunner_guarded_read on public.outrunner_guarded using (exists (select 1 from public.config));`, /policy outrunner_guarded_read/],
  ["a function on its row type", `create function public.outrunner_fn(m public.memory) returns text language sql as 'select m.id';`, /function outrunner_fn/],
  ["a column of its row type", `create table public.outrunner_copies (note public.note);`, /outrunner_copies/],
  ["a default on its sequence", `create sequence public.user_seq owned by public."user".id;
     create table public.outrunner_ids (id bigint default nextval('public.user_seq'));`, /column id of table outrunner_ids/],
] as const) {
  test(`nothing is dropped when ${what} outside the set depends on a legacy table`, { skip }, () => database((sql) => {
    sql(PRODUCTION);
    sql(outside);
    assert.throws(() => sql(`begin; ${drop} commit;`), (error: { stderr?: string }) =>
      /Not dropping the legacy tables/.test(String(error.stderr)) && named.test(String(error.stderr)));
    assert.equal(remaining(sql).split(",").length, 43);
    outrunnerIntact(sql);
  }));
}
