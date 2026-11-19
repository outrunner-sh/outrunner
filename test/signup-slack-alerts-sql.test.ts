/**
 * New users are announced in Slack the first time they finish signing in
 * (20261120100000_signup_slack_alerts.sql), on a real Postgres: auth.users,
 * Vault and pg_net stubbed as Supabase has them, pg_net's request queue a
 * table this test reads.
 *
 * CI supplies the shared server (MISSIONS_PG, or WORKSPACE_WRITES_PG); locally
 * this is skipped without one.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";

const server = process.env.WORKSPACE_WRITES_PG ?? process.env.MISSIONS_PG;
const skip = server ? false : "No local test Postgres configured";
const name = `signup_alerts_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const HOOK = "https://hooks.slack.com/services/T000/B000/xyz";
let url = "";

function psql(target: string, sql: string): string {
  return execFileSync("psql", [target, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql], { encoding: "utf8", stdio: "pipe" }).trim();
}

function sql(text: string): string {
  return psql(url, text);
}

/** What pg_net was asked to send, oldest first. */
function posts(): { url: string; text: string }[] {
  const rows = sql(`select coalesce(json_agg(json_build_object('url', url, 'text', body->>'text') order by id), '[]') from net.sent`);
  return JSON.parse(rows) as { url: string; text: string }[];
}

function signUp(options: { id?: string; email?: string; provider?: string; meta?: object; signedIn?: boolean; anonymous?: boolean } = {}): string {
  const id = options.id ?? randomUUID();
  const meta = JSON.stringify(options.meta ?? {}).replace(/'/g, "''");
  sql(`insert into auth.users (id, email, last_sign_in_at, is_anonymous, raw_app_meta_data, raw_user_meta_data)
    values ('${id}', ${options.email === undefined ? "'new@example.com'" : options.email === "" ? "null" : `'${options.email}'`},
      ${options.signedIn === false ? "null" : "now()"}, ${options.anonymous ? "true" : "false"},
      '${JSON.stringify({ provider: options.provider ?? "github" })}', '${meta}')`);
  return id;
}

before(() => {
  if (!server) return;
  psql(server, `create database ${name}`);
  const target = new URL(server);
  target.pathname = `/${name}`;
  url = target.toString();
  // Supabase's own: auth.users with the columns the trigger reads, Vault's
  // decrypted view, and pg_net's http_post, which here only records.
  sql(`
    create schema auth;
    create table auth.users (
      id uuid primary key, email text, last_sign_in_at timestamptz, is_anonymous boolean not null default false,
      raw_app_meta_data jsonb, raw_user_meta_data jsonb
    );
    create schema vault;
    create table vault.decrypted_secrets (name text, decrypted_secret text);
    create schema net;
    create table net.sent (id bigserial primary key, url text, body jsonb, headers jsonb);
    create table net.refuse (on_ boolean);
    create function net.http_post(url text, body jsonb, headers jsonb) returns bigint language plpgsql as $$
    declare id bigint;
    begin
      if exists (select 1 from net.refuse) then raise exception 'pg_net is down'; end if;
      insert into net.sent (url, body, headers) values (url, body, headers) returning sent.id into id;
      return id;
    end $$;
    create schema extensions;
  `);
  // pg_net is Supabase's; the stub above stands in for it.
  const migration = readFileSync("supabase/migrations/20261120100000_signup_slack_alerts.sql", "utf8");
  assert.match(migration, /create extension if not exists pg_net with schema extensions;/);
  sql(migration.replace("create extension if not exists pg_net with schema extensions;", ""));
});

beforeEach(() => {
  if (!server) return;
  sql(`truncate net.sent; truncate net.refuse; truncate vault.decrypted_secrets; delete from auth.users;
    insert into vault.decrypted_secrets values ('signup_slack_webhook_url', '${HOOK}')`);
});

after(() => {
  if (server) psql(server, `drop database if exists ${name} with (force)`);
});

test("a sign-up that's signed in at once (OAuth) is announced, with who and how", { skip }, () => {
  signUp({ email: "ada@example.com", provider: "google", meta: { full_name: "Ada Lovelace" } });
  assert.deepEqual(posts(), [{ url: HOOK, text: ":wave: New sign-up: Ada Lovelace (ada@example.com) via google" }]);
});

test("an email code is announced when it's used, not when it's sent, and only the first time", { skip }, () => {
  const id = signUp({ email: "code@example.com", provider: "email", signedIn: false });
  assert.deepEqual(posts(), []);
  sql(`update auth.users set last_sign_in_at = now() where id = '${id}'`);
  sql(`update auth.users set last_sign_in_at = now() + interval '1 day' where id = '${id}'`);
  sql(`update auth.users set email = 'other@example.com' where id = '${id}'`);
  assert.deepEqual(posts().map((post) => post.text), [":wave: New sign-up: code@example.com via email"]);
});

test("nothing is sent for an anonymous user, or without the webhook in the vault", { skip }, () => {
  signUp({ anonymous: true });
  sql(`truncate vault.decrypted_secrets`);
  const id = signUp();
  assert.equal(sql(`select count(*) from auth.users where id = '${id}'`), "1");
  assert.deepEqual(posts(), []);
});

test("a name can't become Slack markup, and a user without an email still is one", { skip }, () => {
  signUp({ email: "", meta: { name: "<!channel> & <https://evil.example|click>" } });
  assert.deepEqual(posts().map((post) => post.text), [
    ":wave: New sign-up: &lt;!channel&gt; &amp; &lt;https://evil.example|click&gt; (no email) via github",
  ]);
});

test("a failure to queue the message never fails the sign-in", { skip }, () => {
  sql(`insert into net.refuse values (true)`);
  const id = signUp();
  assert.equal(sql(`select count(*) from auth.users where id = '${id}' and last_sign_in_at is not null`), "1");
  assert.deepEqual(posts(), []);
});
