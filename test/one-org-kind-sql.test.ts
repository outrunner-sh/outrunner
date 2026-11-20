/** Personal orgs becoming ordinary orgs (20261120140000_one_org_kind.sql),
 *  and the read-only query that dry-runs it on production before deploy, on a
 *  disposable Postgres database. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

const server = process.env.MISSIONS_PG;
const skip = server ? false : "No local test Postgres configured";
const name = `one_org_kind_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
let url = "";

function psql(target: string, text: string, quiet = true): string {
  return execFileSync("psql", [target, "-v", "ON_ERROR_STOP=1", ...(quiet ? ["-qtA"] : ["-tA"]), "-c", text], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}
const sql = (text: string) => psql(url, text);

/**
 * What the migration would do, said and changed nothing: run on production,
 * read-only, before deploying. `delete` is a personal org that holds nothing
 * and whose owner is in another org; `rename` one kept and still named
 * "Personal"; `keep` one kept under the name its owner gave it; and
 * `no_app`, of those kept, the ones with repositories but no GitHub App
 * installation: their repositories listed from their owner's own GitHub,
 * and won't any more (lib/github/repository-source.ts). The PR's
 * description carries the same block.
 */
export const DRY_RUN = `
begin transaction read only;
do $$
declare
  ref record;
  holds text := '';
  counts record;
begin
  for ref in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.contype = 'f'
      and c.confrelid = 'public.organizations'::regclass
      and c.conrelid not in ('public.organization_members'::regclass, 'public.access_grants'::regclass)
  loop
    holds := holds || format(' or exists (select 1 from %s t where t.%I = o.id)', ref.tbl, ref.col);
  end loop;
  execute format($q$
    select
      count(*) as personal,
      count(*) filter (where gone) as delete,
      count(*) filter (where not gone and o.name = 'Personal') as rename,
      count(*) filter (where not gone and o.name <> 'Personal') as keep,
      count(*) filter (where not gone
        and exists (select 1 from projects p where p.org_id = o.id)
        and not exists (select 1 from org_github_installations l where l.org_id = o.id)) as no_app
    from organizations o,
    lateral (select
      exists (select 1 from organization_members m where m.user_id = o.personal_owner_id and m.org_id <> o.id)
      and not exists (select 1 from organization_members m where m.org_id = o.id and m.user_id <> o.personal_owner_id)
      and not (false %s) as gone) g
    where o.personal_owner_id is not null
  $q$, holds) into counts;
  raise notice 'personal=% delete=% rename=% keep=% no_app=%', counts.personal, counts.delete, counts.rename, counts.keep, counts.no_app;
end $$;
rollback;`;

/** A user, with what sign-up would have given them; their id. */
function user(meta: Record<string, string>, email: string): string {
  const id = randomUUID();
  sql(`insert into auth.users values ('${id}', '${email}', '${JSON.stringify(meta)}')`);
  return id;
}

/** A personal org for `owner`, as sign-up made one; its id. */
function personal(owner: string, orgName = "Personal"): string {
  const org = sql(`insert into organizations (name, personal_owner_id, created_by) values ('${orgName}', '${owner}', '${owner}') returning id`);
  sql(`insert into organization_members values ('${org}', '${owner}', 'admin'); insert into access_grants values ('${org}')`);
  return org;
}

/** An ordinary org `creator` made, with `members` in it too. */
function team(creator: string, ...members: string[]): string {
  const org = sql(`insert into organizations (name, created_by) values ('Team', '${creator}') returning id`);
  sql(`insert into organization_members values ('${org}', '${creator}', 'admin')`);
  for (const m of members) sql(`insert into organization_members values ('${org}', '${m}', 'member')`);
  return org;
}

const orgName = (id: string) => sql(`select coalesce((select name from organizations where id = '${id}'), '(gone)')`);

before(() => {
  if (!server) return;
  psql(server, `create database ${name}`);
  const u = new URL(server);
  u.pathname = `/${name}`;
  url = u.toString();
  sql(`
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
    create table organizations (
      id uuid primary key default gen_random_uuid(), name text not null,
      personal_owner_id uuid unique references auth.users (id) on delete cascade,
      created_by uuid references auth.users (id) on delete set null,
      created_at timestamptz not null default clock_timestamp()
    );
    create table organization_members (
      org_id uuid references organizations (id) on delete cascade,
      user_id uuid references auth.users (id) on delete cascade,
      role text, primary key (org_id, user_id)
    );
    create table access_grants (org_id uuid references organizations (id) on delete cascade);
    create table subscriptions (id serial primary key, org_id uuid references organizations (id) on delete cascade);
    create table organization_removals (
      org_id uuid references organizations (id) on delete cascade, user_id uuid, removed_by uuid,
      removed_at timestamptz default now(), primary key (org_id, user_id)
    );
    create table member_roles (org_id uuid, user_id uuid);
    create function would_orphan_org(target_org uuid, member uuid) returns boolean language sql as $f$
      select not exists (select 1 from organization_members m
        where m.org_id = target_org and m.user_id <> member and m.role = 'admin')
    $f$;
    -- The guards and defaults as earlier migrations made them.
    create function personal_guard() returns trigger language plpgsql as $f$
    begin
      if exists (select 1 from organizations where id = new.org_id and personal_owner_id is not null) then
        raise exception 'personal' using errcode = 'check_violation';
      end if;
      return new;
    end $f$;
    create function org_provider_keys_team_only() returns trigger language plpgsql as $f$ begin return new; end $f$;
    create function organization_settings_team_only() returns trigger language plpgsql as $f$ begin return new; end $f$;
    create table org_provider_keys (org_id uuid references organizations (id) on delete cascade, provider text);
    create trigger org_provider_keys_team_only before insert on org_provider_keys for each row execute function personal_guard();
    create table organization_settings (org_id uuid primary key references organizations (id) on delete cascade);
    create table org_github_installations (org_id uuid references organizations (id) on delete cascade, installation_id bigint);
    create trigger organization_settings_team_only before insert on organization_settings for each row execute function personal_guard();
    create function projects_default_org() returns trigger language plpgsql as $f$ begin return new; end $f$;
    create function environments_default_org() returns trigger language plpgsql as $f$ begin return new; end $f$;
    create table projects (
      id uuid primary key default gen_random_uuid(), owner_id uuid not null,
      org_id uuid not null references organizations (id) on delete cascade
    );
    create trigger projects_default_org before insert on projects for each row execute function projects_default_org();
    create table environments (
      id uuid primary key default gen_random_uuid(), owner_id uuid not null, default_for_project_id uuid,
      org_id uuid not null references organizations (id) on delete cascade
    );
    create trigger environments_default_org before insert on environments for each row execute function environments_default_org();
  `);
});

after(() => {
  if (server && url) psql(server, `drop database if exists ${name} with (force)`);
});

test("personal orgs become ordinary orgs: empty spares go, the rest keep all they hold", { skip }, () => {
  // Only a personal org: kept, though empty; named after them.
  const ada = user({ full_name: "Ada Lovelace" }, "ada@example.com");
  const adaOrg = personal(ada);
  // Empty, and in another org: deleted. Its access grant, which every org
  // is made with, doesn't count as holding anything.
  const bea = user({ full_name: "Bea" }, "bea@example.com");
  const beaOrg = personal(bea);
  // Holding a project, in another org: kept; no full name, so their login.
  const cy = user({ user_name: "cyberdyne" }, "cy@example.com");
  const cyOrg = personal(cy);
  sql(`insert into projects (owner_id, org_id) values ('${cy}', '${cyOrg}')`);
  // Holding only a subscription, in another org: kept.
  const di = user({ name: "Di Prince" }, "di@example.com");
  const diOrg = personal(di);
  sql(`insert into subscriptions (org_id) values ('${diOrg}')`);
  // Renamed by its owner, empty but for its settings, in another org: kept,
  // under their name.
  const ed = user({ full_name: "Ed" }, "ed@example.com");
  const edOrg = personal(ed, "Side projects");
  sql(`update organizations set personal_owner_id = null where id = '${edOrg}';
       insert into organization_settings values ('${edOrg}');
       update organizations set personal_owner_id = '${ed}' where id = '${edOrg}'`);
  // Nothing but an email: its local part, to the "+tag".
  const fy = user({}, "fy+outrunner@initech.dev");
  const fyOrg = personal(fy);
  sql(`insert into projects (owner_id, org_id) values ('${fy}', '${fyOrg}')`);
  sql(`insert into org_github_installations values ('${fyOrg}', 1)`);
  // The org the others are in; Ada isn't.
  const zed = user({ full_name: "Zed" }, "zed@example.com");
  const shared = team(zed, bea, cy, di, ed);

  // Its answer is a notice, which psql writes to stderr.
  const dryRun = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-tA", "-c", DRY_RUN], { encoding: "utf8" });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  // Cy's and Fy's hold repositories, and only Fy's has the App.
  assert.match(dryRun.stderr, /personal=6 delete=1 rename=4 keep=1 no_app=1/);
  // It changed nothing.
  assert.equal(sql("select count(*) from organizations where personal_owner_id is not null"), "6");

  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "supabase/migrations/20261120140000_one_org_kind.sql"], {
    stdio: "pipe",
  });

  assert.equal(sql("select count(*) from organizations where personal_owner_id is not null"), "0");
  assert.equal(orgName(adaOrg), "Ada's organization");
  assert.equal(orgName(beaOrg), "(gone)");
  assert.equal(orgName(cyOrg), "cyberdyne's organization");
  assert.equal(orgName(diOrg), "Di's organization");
  assert.equal(orgName(edOrg), "Side projects");
  assert.equal(orgName(fyOrg), "fy's organization");
  assert.equal(orgName(shared), "Team");
  // Bea is still in the org she was in.
  assert.equal(sql(`select count(*) from organization_members where user_id = '${bea}'`), "1");
});

test("a former personal org takes keys and defaults, and keeps an admin", { skip }, () => {
  const gil = user({ full_name: "Gil" }, "gil@example.com");
  const own = sql(`insert into organizations (name, created_by) values ('Gil''s organization', '${gil}') returning id`);
  sql(`insert into organization_members values ('${own}', '${gil}', 'admin')`);
  sql(`insert into org_provider_keys values ('${own}', 'openrouter'); insert into organization_settings values ('${own}')`);
  assert.throws(() => sql(`select remove_org_member('${own}', '${gil}', '${gil}')`), /last_admin/);
});

test("a project or environment made with no org goes into its owner's own org: the first they made and administer", { skip }, () => {
  const hal = user({ full_name: "Hal" }, "hal@example.com");
  const someoneElse = user({}, "else@example.com");
  const first = team(hal);
  team(hal);
  // An org they're only a member of, made before either, isn't theirs.
  team(someoneElse, hal);
  assert.equal(sql(`insert into projects (owner_id) values ('${hal}') returning org_id`), first);
  assert.equal(sql(`insert into environments (owner_id) values ('${hal}') returning org_id`), first);
});
