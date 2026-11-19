import assert from "node:assert/strict";
import { test } from "node:test";

import { returnWithoutState } from "@/lib/github/connect-installation";

const TEAM = "00000000-0000-4000-a000-000000000001";
const PERSONAL = "00000000-0000-4000-a000-000000000002";
const OTHER = "00000000-0000-4000-a000-000000000003";

test("back from GitHub without our state: one the org has is refreshed, the active org first", () => {
  assert.deepEqual(
    returnWithoutState({ linkedOrgIds: [PERSONAL, TEAM], activeOrg: { id: TEAM, role: "member" }, ownOrgId: PERSONAL }),
    { kind: "refresh", orgId: TEAM },
  );
  // Looking at another org: their personal org's own installation.
  assert.deepEqual(
    returnWithoutState({ linkedOrgIds: [PERSONAL], activeOrg: { id: TEAM, role: "admin" }, ownOrgId: PERSONAL }),
    { kind: "refresh", orgId: PERSONAL },
  );
});

test("one the org they administer hasn't is offered there, never linked on the way back", () => {
  // Never connected anywhere (Harsh's), or connected to someone else's org.
  for (const linkedOrgIds of [[], [OTHER]]) {
    assert.deepEqual(
      returnWithoutState({ linkedOrgIds, activeOrg: { id: TEAM, role: "admin" }, ownOrgId: PERSONAL }),
      { kind: "offer", orgId: TEAM },
    );
  }
});

test("a member is told only admins add it; unknown to Outrunner, or no org, is the expired link as before", () => {
  assert.deepEqual(
    returnWithoutState({ linkedOrgIds: [], activeOrg: { id: TEAM, role: "member" }, ownOrgId: PERSONAL }),
    { kind: "not_admin" },
  );
  assert.deepEqual(
    returnWithoutState({ linkedOrgIds: null, activeOrg: { id: TEAM, role: "admin" }, ownOrgId: PERSONAL }),
    { kind: "expired" },
  );
  assert.deepEqual(returnWithoutState({ linkedOrgIds: [OTHER], activeOrg: null, ownOrgId: null }), { kind: "expired" });
});
