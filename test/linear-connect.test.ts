import assert from "node:assert/strict";
import { test } from "node:test";

import { linearCallback, type LinearCallbackDeps, type LinearCallbackInput } from "@/lib/trackers/linear-callback";

const TOKENS = { accessToken: "a", refreshToken: "r", expiresAt: new Date(0), refreshExpiresAt: null };
const ORG = { id: "workspace-1", name: "Acme", urlKey: "acme" };
// As real Linear answered, Nov 8: `viewer.app` true for an app's token, false for a person's.
const APP = { id: "app-user", name: "Outrunner", app: true, organization: ORG };
const PERSON = { id: "ana", name: "Ana", app: false, organization: ORG };

function callback(over: Partial<LinearCallbackDeps> = {}, input: Partial<LinearCallbackInput> = {}) {
  const log = { saved: [] as string[], connected: [] as string[], revoked: 0, links: [] as string[], resumed: [] as string[], exchanged: 0 };
  const deps: LinearCallbackDeps = {
    ownerId: async () => "admin-user",
    memberRole: async () => "admin",
    exchange: async () => {
      log.exchanged += 1;
      return TOKENS;
    },
    viewer: async () => APP,
    revoke: async () => {
      log.revoked += 1;
    },
    installation: async () => null,
    orgUses: async () => false,
    orgIds: async () => ["org-1"],
    saveInstall: async ({ viewer }) => {
      log.saved.push(viewer.id);
      return "install";
    },
    connectOrg: async (orgId) => void log.connected.push(orgId),
    audit: async () => undefined,
    saveLink: async ({ viewer }) => void log.links.push(viewer.id),
    resumeLinked: (_i, id) => void log.resumed.push(id),
    ...over,
  };
  const run = linearCallback({ state: { kind: "install", ownerId: "admin-user", orgId: "org-1", nonce: "n" }, nonce: "n", code: "c", error: null, ...input }, deps);
  return { log, run };
}

test("an install with the app's own token connects", async () => {
  const { log, run } = callback();
  assert.deepEqual(await run, { result: "installed", kind: "install" });
  assert.deepEqual(log.saved, ["app-user"]);
  assert.deepEqual(log.connected, ["org-1"]);
});

test("a person's token can't be an install, however the link was edited: it's handed back", async () => {
  for (const viewer of [PERSON, { ...PERSON, app: undefined }]) {
    const { log, run } = callback({ viewer: async () => viewer });
    assert.equal((await run).result, "not_app");
    assert.deepEqual(log.saved, []);
    assert.deepEqual(log.connected, []);
    assert.equal(log.revoked, 1);
  }
});

test("handing it back failing doesn't connect it either", async () => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const { log, run } = callback({ viewer: async () => PERSON, revoke: async () => assert.fail("down") });
    assert.equal((await run).result, "not_app");
    assert.deepEqual(log.saved, []);
  } finally {
    console.warn = warn;
  }
});

test("a working install with another app user isn't taken", async () => {
  const held = async () => ({ id: "install", disconnected: false, appUserId: "other-app" });
  const { log, run } = callback({ installation: held, orgUses: async () => true });
  assert.equal((await run).result, "site_taken");
  assert.deepEqual(log.saved, []);
});

test("a disconnected one: only from an org on it, or with none left", async () => {
  const off = async () => ({ id: "install", disconnected: true, appUserId: "other-app" });
  assert.equal((await callback({ installation: off, orgIds: async () => ["org-other"] }).run).result, "site_taken");
  assert.equal((await callback({ installation: off, orgIds: async () => ["org-other", "org-1"], orgUses: async () => true }).run).result, "installed");
  assert.equal((await callback({ installation: off, orgIds: async () => [] }).run).result, "installed");
});

test("the same app user reconnecting, or another org joining, is fine", async () => {
  const { log, run } = callback({ installation: async () => ({ id: "install", disconnected: false, appUserId: "app-user" }) });
  assert.equal((await run).result, "installed");
  assert.deepEqual(log.connected, ["org-1"]);
});

test("bad state, wrong owner, not an admin: nothing happens", async () => {
  const wrong = callback({}, { nonce: "other" });
  assert.equal((await wrong.run).result, "expired");
  assert.equal(wrong.log.exchanged, 0);
  assert.deepEqual(await callback({}, { state: null }).run, { result: "expired", kind: undefined });
  assert.equal((await callback({ ownerId: async () => "someone" }).run).result, "expired");
  const member = callback({ memberRole: async () => "member" });
  assert.equal((await member.run).result, "not_admin");
  assert.equal(member.log.exchanged, 0);
  assert.equal((await callback({}, { error: "access_denied" }).run).result, "cancelled");
});

const linking = { state: { kind: "link" as const, ownerId: "admin-user", orgId: null, nonce: "n" } };

test("a link is a person's: it's kept, handed back, and carries on what they asked", async () => {
  const known = async () => ({ id: "install", disconnected: false, appUserId: "app-user" });
  const { log, run } = callback({ viewer: async () => PERSON, installation: known }, linking);
  assert.deepEqual(await run, { result: "linked", kind: "link" });
  assert.deepEqual(log.links, ["ana"]);
  assert.deepEqual(log.resumed, ["ana"]);
  assert.equal(log.revoked, 1);
  assert.equal((await callback({ viewer: async () => APP, installation: known }, linking).run).result, "failed");
  assert.equal((await callback({ viewer: async () => PERSON, installation: known, memberRole: async () => null }, linking).run).result, "not_member");
  assert.equal((await callback({ viewer: async () => PERSON }, linking).run).result, "not_installed");
});
