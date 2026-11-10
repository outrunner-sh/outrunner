import assert from "node:assert/strict";
import { test } from "node:test";

import { disconnectOrgFromWorkspace, type DisconnectDeps } from "@/lib/trackers/disconnect";

function harness(links: string[], token: string | null = "tok") {
  const log = { disconnected: 0, revoked: [] as string[], audited: 0 };
  const orgs = new Set(links);
  const deps: DisconnectDeps = {
    removeOrg: async (orgId) => orgs.delete(orgId),
    orgIds: async () => [...orgs],
    load: async () => ({ accessToken: token }),
    markDisconnected: async () => void (log.disconnected += 1),
    revoke: async (t) => void log.revoked.push(t),
    audit: async () => void (log.audited += 1),
  };
  return { deps, log };
}

test("an org that doesn't use the install gets no, and nothing is touched or recorded", async () => {
  // No orgs at all use this one: a careless version would disconnect it.
  const { deps, log } = harness([]);
  assert.equal(await disconnectOrgFromWorkspace("intruder", "install", deps), false);
  assert.deepEqual(log, { disconnected: 0, revoked: [], audited: 0 });
});

test("nor when other orgs use it", async () => {
  const { deps, log } = harness(["org-a"]);
  assert.equal(await disconnectOrgFromWorkspace("intruder", "install", deps), false);
  assert.deepEqual(log, { disconnected: 0, revoked: [], audited: 0 });
});

test("the last org leaving disconnects the install and hands its token back", async () => {
  const { deps, log } = harness(["org-a"]);
  assert.equal(await disconnectOrgFromWorkspace("org-a", "install", deps), true);
  assert.deepEqual(log, { disconnected: 1, revoked: ["tok"], audited: 1 });
});

test("another org still using it keeps it connected", async () => {
  const { deps, log } = harness(["org-a", "org-b"]);
  assert.equal(await disconnectOrgFromWorkspace("org-a", "install", deps), true);
  assert.deepEqual(log, { disconnected: 0, revoked: [], audited: 1 });
});

test("an install with no token left has nothing to revoke", async () => {
  const { deps, log } = harness(["org-a"], null);
  await disconnectOrgFromWorkspace("org-a", "install", deps);
  assert.deepEqual(log.revoked, []);
  assert.equal(log.disconnected, 1);
});
