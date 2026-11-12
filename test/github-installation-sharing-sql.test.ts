/** Who may share a GitHub installation with another org, and for how long, on
 *  a disposable Postgres database: the reported copy of a customer's
 *  installation into an admin's personal org, the audit of links made before
 *  the fix, and revocation when a sharer loses the source org. */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";

const server = process.env.GITHUB_INSTALLATIONS_PG ?? process.env.MISSIONS_PG;
const skip = server ? false : "No local test Postgres configured";
const name = `github_shares_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const FIX = "supabase/migrations/20261112110000_github_installation_share_authority.sql";

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
// People: A and D are admins of the customer's org X; B owns it and its
// installation on GitHub; C administers other team orgs; E owns a GitHub
// user account with the App installed on it.
const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(id);
// Team orgs, and each person's personal org.
const [X, Y, V, W, T, Z, S] = [11, 12, 13, 14, 15, 16, 17].map(id);
const personal = (user: string) => id(100 + Number(user.slice(-2)));
const CUSTOMER = 1001; // On the GitHub organization "customer", installed by B (GitHub id 500).
const OWN = 2002; // On E's own GitHub user account (GitHub id 600).
const SIGNED_IN = 2003; // On C's own GitHub user account (GitHub id 700, C's GitHub sign-in).

let url = "";
function psql(target: string, text: string): string {
  return execFileSync("psql", [target, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", text], { encoding: "utf8", stdio: "pipe" }).trim();
}
const sql = (text: string) => psql(url, text);
const migrate = (file: string) => execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", file], { stdio: "pipe" });
const link = (org: string, installation: number, actor: string, githubId: number | null = null) =>
  sql(`set role service_role; select link_github_installation('${org}', ${installation}, ${githubId ?? "null"}, '${actor}')`);
const linked = (installation: number) =>
  sql(`select org_id from org_github_installations where installation_id = ${installation} order by org_id`).split("\n").filter(Boolean);
const sharedFrom = (org: string, installation: number) =>
  sql(`select shared_from_org from org_github_installations where org_id = '${org}' and installation_id = ${installation}`);
const revoked = (org: string, installation: number) =>
  sql(`select reason from github_installation_link_revocations where org_id = '${org}' and installation_id = ${installation} order by id desc limit 1`);
const member = (org: string, user: string, role = "admin") => sql(`insert into organization_members values ('${org}', '${user}', '${role}')`);
const remove = (org: string, user: string) => sql(`delete from organization_members where org_id = '${org}' and user_id = '${user}'`);

before(() => {
  if (!server) return;
  psql(server, `create database ${name}`);
  const u = new URL(server);
  u.pathname = `/${name}`;
  url = u.toString();
  const users = [A, B, C, D, E];
  sql(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create table auth.identities (user_id uuid references auth.users(id) on delete cascade, provider text, provider_id text);
    create table organizations (id uuid primary key, personal_owner_id uuid unique references auth.users(id) on delete cascade);
    create table organization_members (org_id uuid references organizations(id) on delete cascade,
      user_id uuid references auth.users(id) on delete cascade, role text, primary key(org_id, user_id));
    create table user_github_connections (user_id uuid primary key references auth.users(id) on delete cascade, github_user_id bigint not null);
    create function set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
    do $$ declare r text; begin foreach r in array array['anon','authenticated','service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
    end loop; end $$;
    insert into auth.users values ${users.map((u) => `('${u}')`).join(", ")};
    insert into organizations values ${[X, Y, V, W, T, Z, S].map((o) => `('${o}', null)`).join(", ")},
      ${users.map((u) => `('${personal(u)}', '${u}')`).join(", ")};
    insert into organization_members values ${users.map((u) => `('${personal(u)}', '${u}', 'admin')`).join(", ")};
    insert into auth.identities values ('${B}', 'github', '500'), ('${C}', 'github', '700');
    insert into user_github_connections values ('${E}', 600);
  `);
  for (const file of ["20261029100000_github_installations.sql", "20261029110000_github_installations_claim.sql",
    "20261104100000_shared_github_installations.sql"]) {
    migrate(`supabase/migrations/${file}`);
  }
  sql(`grant select, update on github_installations to service_role;
       grant select, update on organization_members to service_role; grant select on organizations to service_role`);

  // What production may hold: links made under the old rule (an admin of a
  // connected org may link any org they administer), before the fix.
  member(X, B); member(X, A); member(X, D); member(Y, A); member(V, D); member(T, E); member(S, C);
  sql(`insert into github_installations (installation_id, account_login, account_type, repository_selection, installer_id)
       values (${CUSTOMER}, 'customer', 'Organization', 'all', 500), (${OWN}, 'e-on-github', 'User', 'selected', 600),
              (${SIGNED_IN}, 'c-on-github', 'User', 'all', 700)`);
  assert.equal(link(X, CUSTOMER, B, 500), ""); // B installed it on GitHub: the first connection.
  assert.equal(link(personal(A), CUSTOMER, A), ""); // The reported copy into A's personal org.
  assert.equal(link(Y, CUSTOMER, A), ""); // A shares with another team org, and is still X's admin.
  assert.equal(link(V, CUSTOMER, D), ""); // D shares with their own team org...
  remove(X, D); // ...and is then removed from X.
  assert.equal(link(T, OWN, E, 600), ""); // E's own account, first connected to E's team...
  assert.equal(link(personal(E), OWN, E), ""); // ...and then to E's personal org.
  assert.equal(link(S, SIGNED_IN, C, 700), ""); // The same, for C, known by GitHub sign-in alone.
  assert.equal(link(personal(C), SIGNED_IN, C), "");
  if (existsSync(FIX)) migrate(FIX);
});
after(() => {
  if (server) psql(server, `drop database if exists ${name} with (force)`);
});

test("SQL: an org admin's copy of the customer's installation in their personal org is gone, and can't be made again", { skip }, () => {
  // The report: A linked X's installation to A's personal org, which kept
  // App access to the customer's repositories once A left X.
  remove(X, A);
  assert.ok(!linked(CUSTOMER).includes(personal(A)), "A's personal org still holds the customer's installation");
  assert.equal(revoked(personal(A), CUSTOMER), "backfill:personal_org");
  // "Previously authorized" no longer lets A put it back.
  assert.equal(link(personal(A), CUSTOMER, A), "personal_org");
  member(X, A);
  assert.equal(link(personal(A), CUSTOMER, A), "personal_org");
  assert.ok(!linked(CUSTOMER).includes(personal(A)));
});

test("SQL: the backfill keeps roots and live shares, and revokes shares whose sharer lost the source", { skip }, () => {
  assert.equal(sharedFrom(X, CUSTOMER), "");
  assert.equal(revoked(V, CUSTOMER), "backfill:sharer_not_admin");
  assert.ok(!linked(CUSTOMER).includes(V));
  assert.equal(sql(`select root_org_ids from github_installations where installation_id = ${CUSTOMER}`), `{${X}}`);
  // E's own account's installation stays in E's personal org, as a root.
  assert.deepEqual(linked(OWN), [T, personal(E)].sort());
  assert.equal(sharedFrom(personal(E), OWN), "");
  assert.deepEqual(linked(SIGNED_IN), [S, personal(C)].sort());
  // Revoked orgs can't come back as "previously authorized".
  assert.equal(link(V, CUSTOMER, D), "not_admin");
});

test("SQL: a share lasts while its sharer administers the source org, transitively", { skip }, () => {
  // Y was A's share from X (made before the fix, and A was re-added above).
  sql(`delete from org_github_installations where org_id = '${Y}' and installation_id = ${CUSTOMER}`);
  assert.equal(link(Y, CUSTOMER, A), "");
  assert.equal(sharedFrom(Y, CUSTOMER), X);
  // C, an admin of Y but not X, shares on from Y to W.
  member(Y, C); member(W, C);
  assert.equal(link(W, CUSTOMER, C), "");
  assert.equal(sharedFrom(W, CUSTOMER), Y);
  // X removes A: A's share and everything shared from it go.
  remove(X, A);
  assert.deepEqual(linked(CUSTOMER), [X]);
  assert.equal(revoked(Y, CUSTOMER), "sharer_removed");
  assert.equal(revoked(W, CUSTOMER), "sharer_removed");
  // Nor can either of them put it back.
  assert.equal(link(Y, CUSTOMER, A), "not_admin");
  assert.equal(link(W, CUSTOMER, C), "not_admin");
  // Demoted rather than removed: the same.
  member(X, A);
  assert.equal(link(Y, CUSTOMER, A), "");
  sql(`update organization_members set role = 'member' where org_id = '${X}' and user_id = '${A}'`);
  assert.deepEqual(linked(CUSTOMER), [X]);
  assert.equal(revoked(Y, CUSTOMER), "sharer_not_admin");
  // Another sharer's links are their own: B's survive A's demotion.
  member(Y, B);
  assert.equal(link(Y, CUSTOMER, B), "");
  sql(`update organization_members set role = 'admin' where org_id = '${X}' and user_id = '${A}'`);
  remove(X, A);
  assert.deepEqual(linked(CUSTOMER), [X, Y].sort());
});

test("SQL: disconnecting the source, or deleting the sharer's account, revokes the share", { skip }, () => {
  member(Z, B);
  assert.equal(link(Z, CUSTOMER, B), "");
  assert.equal(sharedFrom(Z, CUSTOMER), X);
  sql(`delete from org_github_installations where org_id = '${X}' and installation_id = ${CUSTOMER}`);
  assert.deepEqual(linked(CUSTOMER), []);
  assert.equal(revoked(Z, CUSTOMER), "source_disconnected");
  // X held the root link, so its admins can reconnect it, and share again.
  assert.equal(link(X, CUSTOMER, B), "");
  assert.equal(link(Z, CUSTOMER, B), "");
  sql(`delete from auth.users where id = '${B}'`);
  assert.deepEqual(linked(CUSTOMER), [X]);
  assert.match(revoked(Z, CUSTOMER), /^sharer_(removed|deleted)$/);
});

test("SQL: a GitHub user account's owner links their own installation anywhere they administer; no one else into a personal org", { skip }, () => {
  sql(`delete from org_github_installations where org_id = '${personal(E)}' and installation_id = ${OWN}`);
  member(T, C);
  // C administers T, which has it, but can't copy E's installation into C's personal org.
  assert.equal(link(personal(C), OWN, C), "personal_org");
  // E, verified as the account's GitHub owner (its installer), can, even
  // though it's already connected elsewhere.
  assert.equal(link(personal(E), OWN, E, 600), "");
  assert.equal(sharedFrom(personal(E), OWN), "");
  // A root link isn't tied to its maker's membership elsewhere.
  remove(T, E);
  assert.ok(linked(OWN).includes(personal(E)));
});

test("SQL: a share made while its sharer is being removed doesn't outlive the removal", { skip }, async () => {
  const [Q, R] = [18, 19].map(id);
  sql(`insert into organizations values ('${Q}', null), ('${R}', null)`);
  member(Q, D); member(R, D);
  sql(`insert into github_installations (installation_id, account_login, account_type, repository_selection, installer_id)
       values (3003, 'raced', 'Organization', 'all', 900);
       insert into org_github_installations (org_id, installation_id) values ('${Q}', 3003)`);
  // D shares Q's installation with R in a transaction still open while Q removes D.
  const sharing = new Promise<string>((resolve, reject) =>
    execFile("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c",
      `begin; set role service_role; select coalesce(link_github_installation('${R}', 3003, null, '${D}'), 'linked'); select pg_sleep(1.5); commit;`],
    (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))));
  await new Promise((resolve) => setTimeout(resolve, 500));
  remove(Q, D);
  assert.match(await sharing, /linked/);
  assert.deepEqual(linked(3003), [Q]);
  assert.equal(revoked(R, 3003), "sharer_removed");
});

test("SQL: the log says what took a share: its own disconnect, its source org, its own org, or an uninstall", { skip }, () => {
  const [src, mid, leaf, other] = [20, 21, 22, 23].map(id);
  sql(`insert into organizations values ('${src}', null), ('${mid}', null), ('${leaf}', null), ('${other}', null)`);
  for (const o of [src, mid, leaf, other]) member(o, D);
  sql(`insert into github_installations (installation_id, account_login, account_type, repository_selection, installer_id)
       values (4004, 'logged', 'Organization', 'all', 901);
       insert into org_github_installations (org_id, installation_id) values ('${src}', 4004)`);
  assert.equal(link(mid, 4004, D), "");
  assert.equal(link(leaf, 4004, D), ""); // From src, the root.
  assert.equal(link(other, 4004, D), "");
  sql(`delete from org_github_installations where org_id = '${other}' and installation_id = 4004`);
  assert.equal(revoked(other, 4004), "disconnected");
  sql(`delete from organizations where id = '${leaf}'`);
  assert.equal(revoked(leaf, 4004), "org_deleted");
  sql(`delete from organizations where id = '${src}'`);
  assert.equal(revoked(mid, 4004), "source_deleted");
  sql(`insert into organizations values ('${src}', null); insert into org_github_installations (org_id, installation_id) values ('${src}', 4004)`);
  member(src, D);
  assert.equal(link(mid, 4004, D), "");
  sql("delete from github_installations where installation_id = 4004");
  assert.equal(revoked(mid, 4004), "uninstalled");
});

test("SQL: a share racing its source's disconnect is refused or revoked, never an error", { skip }, async () => {
  const [src, dst] = [24, 25].map(id);
  sql(`insert into organizations values ('${src}', null), ('${dst}', null)`);
  member(src, D); member(dst, D);
  sql(`insert into github_installations (installation_id, account_login, account_type, repository_selection, installer_id)
       values (5005, 'raced-source', 'Organization', 'all', 902);
       insert into org_github_installations (org_id, installation_id) values ('${src}', 5005)`);
  const sharing = new Promise<string>((resolve, reject) =>
    execFile("psql", [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c",
      `begin; set role service_role; select coalesce(link_github_installation('${dst}', 5005, null, '${D}'), 'linked'); select pg_sleep(1.5); commit;`],
    (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))));
  await new Promise((resolve) => setTimeout(resolve, 500));
  sql(`delete from org_github_installations where org_id = '${src}' and installation_id = 5005`);
  assert.match(await sharing, /linked/);
  assert.deepEqual(linked(5005), []);
  assert.equal(revoked(dst, 5005), "source_disconnected");
});

test("SQL: browser clients can't read revocations or call the revocation functions", { skip }, () => {
  for (const role of ["anon", "authenticated"]) {
    assert.throws(() => sql(`set role ${role}; select * from github_installation_link_revocations`), /permission denied/);
    assert.throws(() => sql(`set role ${role}; select revoke_github_installation_shares('${X}', '${A}', 'x')`), /permission denied/);
  }
});
