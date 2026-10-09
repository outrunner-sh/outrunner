import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canRemove,
  invitableRoles,
  managesTeam,
  pickTeam,
  runsSessions,
  sessionAccess,
  sortTeams,
  type Team,
} from "@/lib/teams/roles";

// These mirror the database's checks (20261009140000_team_access.sql, asserted
// in scripts/schema-assertions.sql); the UI offers only what they allow.

test("owners and admins manage a workspace; members and viewers don't", () => {
  assert.deepEqual(
    (["owner", "admin", "member", "viewer", null] as const).map(managesTeam),
    [true, true, false, false, false],
  );
});

test("everyone but viewers runs sessions", () => {
  assert.deepEqual(
    (["owner", "admin", "member", "viewer", null] as const).map(runsSessions),
    [true, true, true, false, false],
  );
});

test("owners invite admins too; admins members and viewers; nobody as owner", () => {
  assert.deepEqual(invitableRoles("owner"), ["admin", "member", "viewer"]);
  assert.deepEqual(invitableRoles("admin"), ["member", "viewer"]);
  assert.deepEqual(invitableRoles("member"), []);
  assert.deepEqual(invitableRoles("viewer"), []);
});

test("owners remove anyone, admins members and viewers, and anyone may leave", () => {
  assert.equal(canRemove("owner", "admin", false), true);
  assert.equal(canRemove("admin", "member", false), true);
  assert.equal(canRemove("admin", "viewer", false), true);
  assert.equal(canRemove("admin", "admin", false), false);
  assert.equal(canRemove("admin", "owner", false), false);
  assert.equal(canRemove("member", "viewer", false), false);
  assert.equal(canRemove("viewer", "owner", true), true, "leaving");
});

test("a session's creator acts in it, managers may stop it, everyone else watches", () => {
  assert.equal(sessionAccess("me", "me", "viewer"), "act", "even a viewer acts in their own");
  assert.equal(sessionAccess("me", "them", "owner"), "manage");
  assert.equal(sessionAccess("me", "them", "admin"), "manage");
  assert.equal(sessionAccess("me", "them", "member"), "watch");
  assert.equal(sessionAccess("me", "them", null), "watch");
});

const personal: Team = { id: "p", name: "Personal", personal: true, role: "owner" };
const acme: Team = { id: "a", name: "Acme", personal: false, role: "member" };
const beta: Team = { id: "b", name: "Beta", personal: false, role: "viewer" };

test("the workspace shown is the one picked last, else the personal one", () => {
  assert.equal(pickTeam([acme, personal], "a"), acme);
  assert.equal(pickTeam([acme, personal], "gone"), personal, "a team left or deleted");
  assert.equal(pickTeam([acme, personal], undefined), personal);
  assert.equal(pickTeam([beta, acme], undefined), beta, "no personal one: the first");
  assert.equal(pickTeam([], "a"), null);
});

test("workspaces list personal first, then by name", () => {
  assert.deepEqual(sortTeams([beta, personal, acme]).map((t) => t.id), ["p", "a", "b"]);
});
