import assert from "node:assert/strict";
import { test } from "node:test";

import type { GitHubRepository } from "@/lib/github/client";
import { returnWithoutState, syncInstallationProjects } from "@/lib/github/connect-installation";

const TEAM = "00000000-0000-4000-a000-000000000001";
const PERSONAL = "00000000-0000-4000-a000-000000000002";
const OTHER = "00000000-0000-4000-a000-000000000003";

test("back from GitHub without our state: one the org has is refreshed, the active org first", () => {
  assert.deepEqual(
    returnWithoutState({ linkedOrgIds: [PERSONAL, TEAM], activeOrg: { id: TEAM, role: "member" }, personalOrgId: PERSONAL }),
    { kind: "refresh", orgId: TEAM },
  );
  // Looking at another org: their personal org's own installation.
  assert.deepEqual(
    returnWithoutState({ linkedOrgIds: [PERSONAL], activeOrg: { id: TEAM, role: "admin" }, personalOrgId: PERSONAL }),
    { kind: "refresh", orgId: PERSONAL },
  );
});

test("one the org they administer hasn't is offered there, never linked on the way back", () => {
  // Never connected anywhere (Harsh's), or connected to someone else's org.
  for (const linkedOrgIds of [[], [OTHER]]) {
    assert.deepEqual(
      returnWithoutState({ linkedOrgIds, activeOrg: { id: TEAM, role: "admin" }, personalOrgId: PERSONAL }),
      { kind: "offer", orgId: TEAM },
    );
  }
});

test("a member is told only admins add it; unknown to Outrunner, or no org, is the expired link as before", () => {
  assert.deepEqual(
    returnWithoutState({ linkedOrgIds: [], activeOrg: { id: TEAM, role: "member" }, personalOrgId: PERSONAL }),
    { kind: "not_admin" },
  );
  assert.deepEqual(
    returnWithoutState({ linkedOrgIds: null, activeOrg: { id: TEAM, role: "admin" }, personalOrgId: PERSONAL }),
    { kind: "expired" },
  );
  assert.deepEqual(returnWithoutState({ linkedOrgIds: [OTHER], activeOrg: null, personalOrgId: null }), { kind: "expired" });
});

const repo = (id: number): GitHubRepository => ({
  githubRepoId: id,
  fullName: `acme/r${id}`,
  owner: "acme",
  ownerType: "Organization",
  avatarUrl: null,
  name: `r${id}`,
  defaultBranch: "main",
  private: true,
  language: null,
  description: null,
  htmlUrl: `https://github.com/acme/r${id}`,
  pushedAt: null,
});

test("just connected: the installation's repositories become the org's projects, as its connector", async () => {
  const saved: Array<{ ownerId: string; ids: number[]; orgId: string }> = [];
  const synced = await syncInstallationProjects(
    { ownerId: "u-harsh", orgId: TEAM, installationId: 7 },
    {
      list: async (id) => (id === 7 ? [repo(1), repo(2)] : []),
      upsert: async (ownerId, repositories, orgId) => {
        saved.push({ ownerId, ids: repositories.map((r) => r.githubRepoId), orgId });
        return repositories.length;
      },
    },
  );
  assert.equal(synced, 2);
  assert.deepEqual(saved, [{ ownerId: "u-harsh", ids: [1, 2], orgId: TEAM }]);
});

test("none to add is 0, nothing written; a failure is null, and the connection stands", async (t) => {
  t.mock.method(console, "error", () => {});
  let writes = 0;
  const upsert = async () => {
    writes++;
    return 0;
  };
  assert.equal(await syncInstallationProjects({ ownerId: "u", orgId: TEAM, installationId: 7 }, { list: async () => [], upsert }), 0);
  assert.equal(writes, 0);
  const failing = { list: async () => { throw new Error("GitHub said no"); }, upsert };
  assert.equal(await syncInstallationProjects({ ownerId: "u", orgId: TEAM, installationId: 7 }, failing), null);
  const unsaved = { list: async () => [repo(1)], upsert: async () => { throw new Error("RLS"); } };
  assert.equal(await syncInstallationProjects({ ownerId: "u", orgId: TEAM, installationId: 7 }, unsaved), null);
});
