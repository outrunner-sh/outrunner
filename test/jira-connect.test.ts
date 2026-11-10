import assert from "node:assert/strict";
import { test } from "node:test";

import { jiraCallback, type JiraCallbackDeps, type JiraCallbackInput } from "@/lib/trackers/jira-callback";
import { type JiraWebhookDeps, refreshJiraWebhooks, REFRESH_WITHIN_MS, REREGISTER_WITHIN_MS, syncJiraWebhook } from "@/lib/trackers/jira-webhooks";

const SITE = { id: "cloud-1", name: "Acme", url: "https://acme.atlassian.net" };
const ME = { accountId: "service", name: "Outrunner" };
const TOKENS = { accessToken: "a", refreshToken: "r", expiresAt: new Date(0), refreshExpiresAt: null };

function callback(over: Partial<JiraCallbackDeps> = {}, input: Partial<JiraCallbackInput> = {}) {
  const log = { saved: [] as { accountId: string; name: string | null }[], connected: [] as string[], synced: 0, links: [] as unknown[], audits: 0, exchanged: 0, resumed: [] as string[], adminChecks: 0, evicted: [] as unknown[] };
  const deps: JiraCallbackDeps = {
    ownerId: async () => "admin-user",
    memberRole: async () => "admin",
    exchange: async () => {
      log.exchanged += 1;
      return TOKENS;
    },
    sites: async () => [SITE],
    me: async () => ME,
    installation: async () => null,
    orgUses: async () => false,
    orgIds: async () => ["org-1"],
    saveInstall: async ({ me }) => {
      log.saved.push(me);
      return "install";
    },
    connectOrg: async (orgId) => void log.connected.push(orgId),
    audit: async () => {
      log.audits += 1;
    },
    syncWebhook: async () => {
      log.synced += 1;
    },
    saveLink: async (link) => void log.links.push(link),
    resumeLinked: (installationId, accountId) => void log.resumed.push(`${installationId}/${accountId}`),
    isSiteAdmin: async () => {
      log.adminChecks += 1;
      return true;
    },
    evict: async (installationId, by) => void log.evicted.push({ installationId, ...by }),
    ...over,
  };
  const run = jiraCallback({ state: { kind: "install", ownerId: "admin-user", orgId: "org-1", nonce: "n" }, nonce: "n", code: "c", error: null, ...input }, deps);
  return { log, run };
}

test("a first install: saved with who it's connected as, the org linked, the webhook set", async () => {
  const { log, run } = callback();
  assert.deepEqual(await run, { result: "installed", kind: "install" });
  assert.deepEqual(log.saved, [ME]);
  assert.deepEqual(log.connected, ["org-1"]);
  assert.equal(log.synced, 1);
  assert.equal(log.audits, 1);
});

test("a wrong nonce, no state, or someone else signed in: nothing happens", async () => {
  const wrong = callback({}, { nonce: "other" });
  assert.equal((await wrong.run).result, "expired");
  assert.equal(wrong.log.exchanged, 0);
  assert.equal((await callback({}, { nonce: undefined }).run).result, "expired");
  assert.deepEqual(await callback({}, { state: null }).run, { result: "expired", kind: undefined });
  const owner = callback({ ownerId: async () => "someone-else" });
  assert.equal((await owner.run).result, "expired");
  assert.equal(owner.log.exchanged, 0);
  assert.equal((await callback({ ownerId: async () => null }).run).result, "expired");
  assert.equal((await callback({}, { code: null }).run).result, "expired");
  assert.equal((await callback({}, { error: "access_denied" }).run).result, "cancelled");
});

test("no longer their org's admin: nothing happens", async () => {
  const { log, run } = callback({ memberRole: async () => "member" });
  assert.equal((await run).result, "not_admin");
  assert.equal(log.exchanged, 0);
});

test("an account reaching several sites is refused: a grant has one refresh token", async () => {
  const { log, run } = callback({ sites: async () => [SITE, { ...SITE, id: "cloud-2" }] });
  assert.equal((await run).result, "many_sites");
  assert.deepEqual(log.saved, []);
});

test("a working install isn't taken by another account", async () => {
  const { log, run } = callback({ installation: async () => ({ id: "install", disconnected: false, appUserId: "someone" }), orgUses: async () => true });
  assert.equal((await run).result, "site_taken");
  assert.deepEqual(log.saved, []);
  assert.deepEqual(log.connected, []);
});

test("a disconnected install isn't taken by another account from an org not on it", async () => {
  // A refused refresh disconnects too, with other orgs still linked through it.
  const { log, run } = callback({ installation: async () => ({ id: "install", disconnected: true, appUserId: "someone" }), orgIds: async () => ["org-other"], orgUses: async () => false });
  assert.equal((await run).result, "site_taken");
  assert.deepEqual(log.saved, []);
});

test("a disconnected install with other orgs still on it stays theirs", async () => {
  const { log, run } = callback({ installation: async () => ({ id: "install", disconnected: true, appUserId: "someone" }), orgIds: async () => ["org-other"], orgUses: async () => false });
  assert.equal((await run).result, "site_taken");
  assert.deepEqual(log.saved, []);
});

test("no org left on it, a site is free: the last one leaving doesn't lock it for good", async () => {
  const { log, run } = callback({ installation: async () => ({ id: "install", disconnected: true, appUserId: "someone" }), orgIds: async () => [], orgUses: async () => false });
  assert.equal((await run).result, "installed");
  assert.deepEqual(log.saved, [ME]);
  assert.deepEqual(log.connected, ["org-1"]);
});

test("an org already on a disconnected install may reconnect it as another account", async () => {
  const { log, run } = callback({ installation: async () => ({ id: "install", disconnected: true, appUserId: "someone" }), orgUses: async () => true });
  assert.equal((await run).result, "installed");
  assert.deepEqual(log.saved, [ME]);
});

test("the same account always may: that's how another org joins", async () => {
  const { log, run } = callback({ installation: async () => ({ id: "install", disconnected: false, appUserId: "service" }) });
  assert.equal((await run).result, "installed");
  assert.deepEqual(log.connected, ["org-1"]);
});

test("failing part way says so", async () => {
  const error = console.error;
  console.error = () => undefined;
  try {
    assert.equal((await callback({ exchange: async () => assert.fail("boom") }).run).result, "failed");
    assert.equal((await callback({ me: async () => null }).run).result, "failed");
  } finally {
    console.error = error;
  }
});

const linkState = { state: { kind: "link" as const, ownerId: "admin-user", orgId: null, nonce: "n" } };

test("a link: only for someone in an org using that site, only as who signed in", async () => {
  const known = async () => ({ id: "install", disconnected: false, appUserId: "service" });
  const linked = callback({ installation: known, me: async () => ({ accountId: "ana", name: "Ana" }) }, linkState);
  assert.deepEqual(await linked.run, { result: "linked", kind: "link" });
  assert.deepEqual(linked.log.links, [{ installationId: "install", accountId: "ana", name: "Ana", ownerId: "admin-user" }]);
  assert.deepEqual(linked.log.saved, [], "a link is never an install");
  assert.deepEqual(linked.log.resumed, ["install/ana"], "what they asked for carries on");
  assert.equal((await callback({ installation: known, memberRole: async () => null }, linkState).run).result, "not_member");
  assert.equal((await callback({}, linkState).run).result, "not_installed");
});

const reclaiming = { state: { kind: "reclaim" as const, ownerId: "admin-user", orgId: "org-1", nonce: "n", siteId: SITE.id } };
const held = async () => ({ id: "install", disconnected: false, appUserId: "someone" });

test("a site someone else holds says which, for its admin to clear", async () => {
  assert.deepEqual(await callback({ installation: held }).run, { result: "site_taken", kind: "install", siteId: SITE.id });
});

test("the site's Jira admin clears it: whoever holds it goes, and nothing is connected or kept", async () => {
  const { log, run } = callback({ installation: held }, reclaiming);
  assert.deepEqual(await run, { result: "reclaimed", kind: "reclaim" });
  assert.deepEqual(log.evicted, [{ installationId: "install", orgId: "org-1", ownerId: "admin-user" }]);
  assert.deepEqual(log.saved, [], "their account isn't the install");
  assert.deepEqual(log.connected, []);
  assert.deepEqual(log.links, []);
});

test("Jira saying no changes nothing", async () => {
  const { log, run } = callback({ installation: held, isSiteAdmin: async () => false }, reclaiming);
  assert.equal((await run).result, "not_site_admin");
  assert.deepEqual(log.evicted, []);
});

test("an admin of another site proves nothing: the grant has to reach this one, and isn't even asked", async () => {
  const { log, run } = callback({ installation: held, sites: async () => [{ ...SITE, id: "other-site" }] }, reclaiming);
  assert.equal((await run).result, "not_site_admin");
  assert.equal(log.adminChecks, 0);
  assert.deepEqual(log.evicted, []);
});

test("only the org's own admin can start or finish it", async () => {
  const { log, run } = callback({ installation: held, memberRole: async () => "member" }, reclaiming);
  assert.equal((await run).result, "not_admin");
  assert.equal(log.exchanged, 0, "not even a look at Atlassian");
  assert.equal((await callback({ installation: held, ownerId: async () => "someone-else" }, reclaiming).run).result, "expired");
  assert.equal((await callback({ installation: held }, { ...reclaiming, nonce: "other" }).run).result, "expired");
});

test("a site nobody holds has nothing to clear", async () => {
  const { log, run } = callback({}, reclaiming);
  assert.equal((await run).result, "reclaimed");
  assert.deepEqual(log.evicted, []);
});

test("Jira failing to answer changes nothing", async () => {
  const error = console.error;
  console.error = () => undefined;
  try {
    const { log, run } = callback({ installation: held, isSiteAdmin: async () => assert.fail("down") }, reclaiming);
    assert.equal((await run).result, "failed");
    assert.deepEqual(log.evicted, []);
  } finally {
    console.error = error;
  }
});

test("reclaimed, then a real install: free, as no org is left on it", async () => {
  const { log, run } = callback({ installation: async () => ({ id: "install", disconnected: true, appUserId: "someone" }), orgIds: async () => [], orgUses: async () => false });
  assert.equal((await run).result, "installed");
  assert.deepEqual(log.saved, [ME]);
});

// --- The webhook

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function webhooks(over: Partial<JiraWebhookDeps> = {}, setup: { projects?: string[]; webhookId?: number | null } = {}) {
  const log: string[] = [];
  const saved: { webhookId: number | null; expiresAt: Date | null }[] = [];
  const deps: JiraWebhookDeps = {
    webhookUrl: () => "https://app.test/w",
    install: async () => ({ provider: "jira", disconnected: false, webhookId: setup.webhookId === undefined ? 1 : setup.webhookId }),
    projects: async () => setup.projects ?? ["10000"],
    register: async () => {
      log.push("register");
      return 2;
    },
    remove: async (_i, id) => void log.push(`remove ${id}`),
    refresh: async () => {
      log.push("refresh");
      return new Date(NOW + 30 * DAY);
    },
    save: async (_i, webhookId, expiresAt) => {
      log.push("save");
      saved.push({ webhookId, expiresAt });
    },
    due: async () => [],
    missing: async () => [],
    now: () => NOW,
    ...over,
  };
  return { deps, log, saved };
}

test("a change of projects registers the new, keeps it, then removes the old", async () => {
  const { deps, log, saved } = webhooks();
  await syncJiraWebhook("i", deps);
  assert.deepEqual(log, ["register", "save", "remove 1"]);
  assert.deepEqual(saved, [{ webhookId: 2, expiresAt: new Date(NOW + 30 * DAY) }]);
});

test("the old one failing to go doesn't undo the new", async () => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const { deps, saved } = webhooks({ remove: async () => assert.fail("boom") });
    await syncJiraWebhook("i", deps);
    assert.equal(saved[0]?.webhookId, 2);
  } finally {
    console.warn = warn;
  }
});

test("no projects left: the webhook goes; disconnected or not set up: nothing is touched", async () => {
  const none = webhooks({}, { projects: [] });
  await syncJiraWebhook("i", none.deps);
  assert.deepEqual(none.log, ["save", "remove 1"]);
  assert.deepEqual(none.saved, [{ webhookId: null, expiresAt: null }]);
  const neither = webhooks({}, { projects: [], webhookId: null });
  await syncJiraWebhook("i", neither.deps);
  assert.deepEqual(neither.log, []);
  const off = webhooks({ install: async () => ({ provider: "jira", disconnected: true, webhookId: 1 }) });
  await syncJiraWebhook("i", off.deps);
  assert.deepEqual(off.log, []);
  const unset = webhooks({ webhookUrl: () => null });
  await syncJiraWebhook("i", unset.deps);
  assert.deepEqual(unset.log, []);
  const lost = webhooks({ register: async () => null });
  await syncJiraWebhook("i", lost.deps);
  assert.deepEqual(lost.saved, [], "no token: what's there stays");
});

const dueSoon = (expiresAt: number | null) => async () => [{ id: "i", webhookId: 1, expiresAt }];

test("the tick extends what's due, and asks for what's within five days", async () => {
  let before = 0;
  const { deps, log, saved } = webhooks({
    due: async (at) => {
      before = at;
      return [{ id: "i", webhookId: 1, expiresAt: NOW + 4 * DAY }];
    },
  });
  assert.equal(await refreshJiraWebhooks(deps), 1);
  assert.equal(before, NOW + REFRESH_WITHIN_MS);
  assert.deepEqual(log, ["refresh", "save"]);
  assert.equal(saved[0]?.webhookId, 1);
});

test("a webhook Jira no longer has starts again", async () => {
  const { deps, log } = webhooks({ due: dueSoon(NOW + 4 * DAY), refresh: async () => null });
  await refreshJiraWebhooks(deps);
  assert.deepEqual(log, ["register", "save", "remove 1"]);
});

test("a refresh that throws is tried again while there's time, and starts again when there isn't", async () => {
  const quiet = { error: console.error, warn: console.warn };
  console.error = () => undefined;
  console.warn = () => undefined;
  try {
    const early = webhooks({ due: dueSoon(NOW + REREGISTER_WITHIN_MS + DAY), refresh: async () => assert.fail("no such path") });
    assert.equal(await refreshJiraWebhooks(early.deps), 0);
    assert.deepEqual(early.log, []);

    const late = webhooks({ due: dueSoon(NOW + DAY), refresh: async () => assert.fail("no such path") });
    assert.equal(await refreshJiraWebhooks(late.deps), 1);
    assert.deepEqual(late.log, ["register", "save", "remove 1"], "not left to die in silence");
  } finally {
    console.error = quiet.error;
    console.warn = quiet.warn;
  }
});

test("a site with projects and no webhook is repaired; one with no projects has nothing to do", async () => {
  const missing = webhooks({ missing: async () => ["i"] }, { webhookId: null });
  assert.equal(await refreshJiraWebhooks(missing.deps), 1);
  assert.deepEqual(missing.log, ["register", "save"]);
  const empty = webhooks({ missing: async () => ["i"] }, { projects: [], webhookId: null });
  assert.equal(await refreshJiraWebhooks(empty.deps), 0);
});

test("one site failing doesn't stop the rest", async () => {
  const error = console.error;
  console.error = () => undefined;
  try {
    let tried = 0;
    const { deps } = webhooks({
      missing: async () => ["a", "b"],
      register: async () => {
        tried += 1;
        if (tried === 1) throw new Error("boom");
        return 2;
      },
    }, { webhookId: null });
    assert.equal(await refreshJiraWebhooks(deps), 1);
    assert.equal(tried, 2);
  } finally {
    console.error = error;
  }
});

test("a webhook Jira no longer has is replaced, and the next refresh uses the new one", async () => {
  let stored = { id: "i", webhookId: 1, expiresAt: NOW + 4 * DAY };
  const refreshed: number[] = [];
  const { deps, saved } = webhooks({
    due: async () => [stored],
    refresh: async (_i, id) => {
      refreshed.push(id);
      return id === 1 ? null : new Date(NOW + 30 * DAY);
    },
    save: async (_i, webhookId, expiresAt) => {
      saved.push({ webhookId, expiresAt });
      stored = { ...stored, webhookId: webhookId as number };
    },
  });
  await refreshJiraWebhooks(deps);
  assert.equal(stored.webhookId, 2);
  await refreshJiraWebhooks(deps);
  assert.deepEqual(refreshed, [1, 2]);
});

test("a refresh that can't read the list registers nothing, while there's time", async () => {
  const { deps, log } = webhooks({
    due: async () => [{ id: "i", webhookId: 1, expiresAt: NOW + REREGISTER_WITHIN_MS + DAY }],
    refresh: async () => {
      throw new Error("500");
    },
  });
  assert.equal(await refreshJiraWebhooks(deps), 0);
  assert.equal(log.includes("register"), false);
});
