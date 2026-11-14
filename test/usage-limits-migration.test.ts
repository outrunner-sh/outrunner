/** Runs 20261114120000_usage_limits_in_dollars.sql for real against a test
 * Postgres server (USAGE_LIMITS_PG, as CI sets; skipped without one), in a
 * database it creates and drops: an old percentage limit becomes an alert,
 * and the new columns and checks hold. Never points at the application
 * database. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const server = process.env.USAGE_LIMITS_PG;
const migration = (name: string) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

test("usage limits in dollars: old % limits become alerts, and the checks hold", { skip: !server }, () => {
  const db = `usage_limits_test_${randomUUID().replaceAll("-", "")}`;
  const psql = (database: string, input: string) => {
    const url = new URL(server!);
    url.pathname = `/${database}`;
    return execFileSync("psql", [url.toString(), "-v", "ON_ERROR_STOP=1", "-Atq"], { input, encoding: "utf8", stdio: "pipe" }).trim();
  };
  psql("postgres", `create database ${db}`);
  const sql = (input: string) => psql(db, input);
  try {
    sql(`create table organizations(id uuid primary key, personal_owner_id uuid);
      create table organization_settings(org_id uuid primary key references organizations(id), updated_by uuid,
        default_model jsonb, box_size text, archive_on_close boolean not null default true);
      -- The guard as 20261030150000_org_defaults.sql made it: no row at all for a personal org.
      create function organization_settings_team_only() returns trigger language plpgsql as $$ begin
        if exists (select 1 from organizations where id = new.org_id and personal_owner_id is not null) then
          raise exception 'a personal org''s defaults are its owner''s own' using errcode = 'check_violation';
        end if;
        return new;
      end $$;
      create trigger organization_settings_team_only before insert or update on organization_settings
        for each row execute function organization_settings_team_only();
      create table subscriptions(stripe_subscription_id text primary key, org_id uuid);
      do $$ begin
        if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
        if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      end $$;`);
    // The real schema the new migration starts from.
    sql(migration("20261101100000_org_usage_controls.sql"));
    const orgs: Array<[number | null, string, string]> = [
      // [old limit %, old alerts, alerts after]
      [25, "{100}", "{50,100}"],
      [80, "{}", "{80}"],
      [90, "{50}", "{50,80}"],
      [100, "{80,100}", "{80,100}"],
      [null, "{80}", "{80}"],
    ];
    const ids = orgs.map(() => randomUUID());
    orgs.forEach(([limit, alerts], i) => {
      sql(`insert into organizations values('${ids[i]}');
        insert into organization_settings(org_id, usage_limit_percent, alert_thresholds) values('${ids[i]}', ${limit ?? "null"}, '${alerts}');`);
    });

    sql(migration("20261114120000_usage_limits_in_dollars.sql"));
    orgs.forEach(([limit, , after], i) => {
      assert.equal(sql(`select alert_thresholds from organization_settings where org_id='${ids[i]}'`), after, `${limit}%`);
      assert.equal(sql(`select usage_limit_usd is null from organization_settings where org_id='${ids[i]}'`), "t");
    });
    assert.equal(sql(`select count(*) from information_schema.columns where table_name='organization_settings' and column_name='usage_limit_percent'`), "0");

    sql(`update organization_settings set usage_limit_usd = 30.50, alert_thresholds = '{150,200}' where org_id='${ids[0]}'`);
    assert.equal(sql(`select usage_limit_usd from organization_settings where org_id='${ids[0]}'`), "30.50");
    assert.throws(() => sql(`update organization_settings set usage_limit_usd = 0 where org_id='${ids[0]}'`), /check constraint/);
    assert.throws(() => sql(`update organization_settings set alert_thresholds = '{70}' where org_id='${ids[0]}'`), /check constraint/);

    sql(`insert into subscriptions values('sub_1', '${ids[0]}')`);
    assert.equal(sql(`select overage_unpaid_since is null from subscriptions`), "t");

    // A personal org's owner sets its usage controls; its session defaults stay theirs alone.
    const personal = randomUUID();
    sql(`insert into organizations values('${personal}', '${randomUUID()}')`);
    sql(`insert into organization_settings(org_id, usage_limit_usd, alert_thresholds) values('${personal}', 40, '{100,150}')`);
    sql(`update organization_settings set alert_thresholds = '{50}' where org_id='${personal}'`);
    assert.equal(sql(`select alert_thresholds from organization_settings where org_id='${personal}'`), "{50}");
    for (const set of ["box_size = 'large'", `default_model = '{"id":"x"}'`, "archive_on_close = false"]) {
      assert.throws(() => sql(`update organization_settings set ${set} where org_id='${personal}'`), /owner's own/, set);
    }
    sql(`update organization_settings set box_size = 'large' where org_id='${ids[0]}'`);

    // Run again (a retried deploy): nothing changes, nothing fails.
    sql(migration("20261114120000_usage_limits_in_dollars.sql"));
    assert.equal(sql(`select alert_thresholds from organization_settings where org_id='${ids[0]}'`), "{150,200}");
  } finally {
    psql("postgres", `drop database ${db} with (force)`);
  }
});
