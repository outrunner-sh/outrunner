/** Run against a disposable PostgreSQL container only:
 * CODEX_TEST_POSTGRES_CONTAINER=outrunner-codex-test-db pnpm test
 * Creates/drops its own database. Never points at the application database. */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { test } from "node:test";
const container = process.env.CODEX_TEST_POSTGRES_CONTAINER;
const server = process.env.CODEX_AUTH_PG;
test(
  "PostgreSQL: role gates, leases, refresh/replacement fences, expiry, cancellation and RLS",
  { skip: !container && !server },
  async () => {
    if (container) assert.match(container, /^outrunner-codex-test[-a-z0-9]*$/);
    const db = `codex_test_${randomUUID().replaceAll("-", "")}`;
    const connection = (database?: string): [string, string[]] => {
      if (container)
        return [
          "docker",
          [
            "exec",
            "-i",
            container,
            "psql",
            "-U",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-Atq",
            "-d",
            database ?? "postgres",
          ],
        ];
      const url = new URL(server!);
      if (database) url.pathname = `/${database}`;
      return ["psql", [url.toString(), "-v", "ON_ERROR_STOP=1", "-Atq"]];
    };
    const [binary, args] = connection();
    execFileSync(binary, [...args, "-c", `create database ${db}`], {
      stdio: "pipe",
    });
    const [queryBinary, command] = connection(db);
    const sql = (query: string) =>
      execFileSync(queryBinary, command, {
        input: query,
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    try {
      sql(`create schema auth; create table auth.users(id uuid primary key);
      create table organizations(id uuid primary key);
      create table organization_members(org_id uuid, user_id uuid, role text);
      create table user_provider_keys(user_id uuid, provider text);
      create function set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
      do $$ begin
        if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
        if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
        if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
      end $$;`);
      // Start from the real pre-Codex schema, including its old method CHECK.
      sql(readFileSync(new URL("../supabase/migrations/20261020120000_user_agent_auth.sql", import.meta.url), "utf8"));
      const existing = randomUUID();
      sql(`insert into auth.users values('${existing}'); insert into user_agent_auth(user_id,agent,method) values('${existing}','codex','api-key');`);
      assert.throws(() => sql(`update user_agent_auth set method='codex-account' where user_id='${existing}'`), /Command failed/);
      assert.equal(sql(`select method from user_agent_auth where user_id='${existing}'`), "api-key", "failed update preserves existing choice");
      sql(
        readFileSync(
          new URL(
            "../supabase/migrations/20261103190000_codex_connections.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      assert.equal(sql(`select method from user_agent_auth where user_id='${existing}'`), "api-key", "migration never rewrites the saved API-key choice");
      sql(`update user_agent_auth set method='codex-account' where user_id='${existing}';`);
      assert.equal(sql(`select method from user_agent_auth where user_id='${existing}'`), "codex-account", "the existing user can choose account auth after migration");
      const admin = randomUUID(),
        member = randomUUID(),
        org = randomUUID(),
        other = randomUUID();
      sql(
        `insert into auth.users values('${admin}'),('${member}'); insert into organizations values('${org}'),('${other}'); insert into organization_members values('${org}','${admin}','admin'),('${org}','${member}','member');`,
      );
      const key = `org:${org}`;
      const call = (op: string, args: object, k = key) =>
        `select codex_connection_change('${k}','${op}','${JSON.stringify(args)}'::jsonb);`;
      const change = (op: string, args: object, k = key) =>
        JSON.parse(sql(call(op, args, k)));
      const attempt = randomUUID();
      assert.throws(
        () => change("begin", { actor: member, attempt }),
        /Command failed/,
      );
      assert.throws(
        () => change("begin", { actor: admin, attempt }, `org:${other}`),
        /Command failed/,
      );
      change("begin", { actor: admin, attempt });
      const saved = change("save", {
        actor: admin,
        attempt,
        ciphertext: "synthetic-sealed-login",
      });
      assert.equal(saved.claimed, true);
      const generation = saved.row.generation,
        revision = saved.row.revision;
      const usable = (
        actor = member,
        organization = org,
        connection = key,
        gen = generation,
      ) =>
        sql(
          `select codex_connection_use('${connection}','${actor}','${organization}','${gen}')`,
        );
      assert.equal(usable(), "t");
      assert.equal(usable(admin), "t");
      assert.equal(usable(member, other), "f");
      sql(`insert into user_provider_keys values('${member}','openai')`);
      assert.equal(usable(), "f", "personal API key keeps precedence");
      sql(
        `insert into user_agent_auth(user_id,agent,method) values('${member}','codex','codex-account')`,
      );
      assert.equal(usable(), "t", "explicit account choice may use org");
      sql(
        `update user_agent_auth set method='api-key' where user_id='${member}'`,
      );
      assert.equal(usable(), "f");
      sql(
        `delete from user_agent_auth; delete from user_provider_keys; delete from organization_members where user_id='${member}'`,
      );
      assert.equal(usable(), "f", "removed member cannot use a retained grant");
      sql(
        `insert into organization_members values('${org}','${member}','member')`,
      );

      const locks = await Promise.all(
        Array.from({ length: 16 }, async () => {
          const lease = randomUUID();
          const { stdout } = await promisify(execFile)(queryBinary, [
            ...command,
            "-c",
            call("lease", { generation, revision, lease }),
          ]);
          return { ...JSON.parse(stdout.trim()), lease };
        }),
      );
      assert.equal(locks.filter((x) => x.claimed).length, 1);
      const lease = locks.find((x) => x.claimed).lease;
      // A transient failure releases the lease, retaining the credential and
      // imposing a shared retry delay rather than asking everyone to log in.
      assert.equal(
        change("release", { generation, lease }).row.status,
        "connected",
      );
      assert.equal(
        change("lease", { generation, revision, lease }).claimed,
        false,
      );
      sql(
        `update codex_connections set retry_until=now()-interval '1 second' where key='${key}'`,
      );
      assert.equal(
        change("lease", { generation, revision, lease }).claimed,
        true,
      );
      // Disconnect invalidates even a lease already held by another controller.
      change("disconnect", { actor: admin });
      assert.equal(usable(), "f", "disconnect revokes a retained grant");
      assert.equal(
        change("finish", { generation, lease, ciphertext: "must-not-return" })
          .claimed,
        false,
      );
      assert.equal(
        sql(
          `select status || ':' || coalesce(ciphertext,'empty') from codex_connections where key='${key}'`,
        ),
        "disconnected:empty",
      );
      assert.equal(
        change("save", { actor: admin, attempt, ciphertext: "late-upload" })
          .claimed,
        false,
      );
      const next = randomUUID();
      change("begin", { actor: admin, attempt: next });
      sql(
        `update codex_connections set pending_until=now()-interval '1 second' where key='${key}'`,
      );
      assert.equal(
        change("save", { actor: admin, attempt: next, ciphertext: "expired" })
          .claimed,
        false,
      );
      const canceled = randomUUID();
      change("begin", { actor: admin, attempt: canceled });
      change("cancel", { actor: admin, attempt: canceled });
      assert.equal(
        change("save", {
          actor: admin,
          attempt: canceled,
          ciphertext: "canceled",
        }).claimed,
        false,
      );
      // Removing the admin between login and upload is enforced inside the DB.
      const removed = randomUUID();
      change("begin", { actor: admin, attempt: removed });
      sql(`delete from organization_members where user_id='${admin}'`);
      assert.throws(() =>
        change("save", {
          actor: admin,
          attempt: removed,
          ciphertext: "no-longer-admin",
        }),
      );
      assert.throws(() =>
        sql(`set role authenticated; select * from codex_connections;`),
      );
      assert.throws(() =>
        sql(`set role authenticated; ${call("disconnect", { actor: admin })}`),
      );
    } finally {
      execFileSync(
        binary,
        [...args, "-c", `drop database ${db} with (force)`],
        { stdio: "pipe" },
      );
    }
  },
);
