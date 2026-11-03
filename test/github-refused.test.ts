import assert from "node:assert/strict";
import { test } from "node:test";

import { GitHubReconnectError, GitHubSyncError } from "@/lib/github/client";
import type { GitCredential } from "@/lib/github/identity";
import { callWithCredential, retryInstallationToken, type RefusalDeps, type RefusalLog, type TokenVerdict } from "@/lib/github/refused";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const where = { route: "pull-request", repo: "acme/web" };

/** Credentials handed out in turn, GitHub's verdict on a personal token, and
 *  what was logged and forgotten. */
function deps(credentials: GitCredential[], verdict: TokenVerdict = "dead") {
  const logs: RefusalLog[] = [];
  const forgotten: string[] = [];
  let next = 0;
  const d: RefusalDeps = {
    resolve: async () => credentials[Math.min(next++, credentials.length - 1)]!,
    forget: (c) => void forgotten.push(c.token),
    check: async () => verdict,
    storedAt: async () => new Date(NOW - 45 * 60_000),
    log: (entry) => void logs.push(entry),
    now: () => NOW,
  };
  return { d, logs, forgotten, resolved: () => next };
}

const app = (token: string, mintedMinutesAgo: number): GitCredential => ({
  identity: "app",
  token,
  expiresAt: new Date(NOW + (60 - mintedMinutesAgo) * 60_000),
  installationId: 42,
});
const personal: GitCredential = { identity: "personal", token: "gho_mine", expiresAt: null, installationId: null };

/** Refuses the tokens named, as GitHub does a dead one: 401. */
const refusing = (...dead: string[]) => async (token: string) => {
  if (dead.includes(token)) throw new GitHubReconnectError(undefined, 401);
  return `ok with ${token}`;
};

test("an App token GitHub refuses is minted afresh, never said as the user's connection expiring", async () => {
  const { d, logs, forgotten } = deps([app("ghs_stale", 55), app("ghs_fresh", 0)]);
  assert.equal(await callWithCredential(where, refusing("ghs_stale"), d), "ok with ghs_fresh");
  assert.deepEqual(forgotten, ["ghs_stale"]);
  assert.deepEqual(logs, [
    { ...where, kind: "installation", prefix: "ghs_", ageMinutes: 55, installationId: 42, status: 401, attempt: 1 },
  ]);
});

test("an App token refused twice is a retry, not a reconnect", async () => {
  const { d, logs } = deps([app("ghs_one", 10), app("ghs_two", 0)]);
  await assert.rejects(
    callWithCredential(where, refusing("ghs_one", "ghs_two"), d),
    (e: unknown) => e instanceof GitHubSyncError && !(e instanceof GitHubReconnectError) && /GitHub App/.test(e.message),
  );
  assert.deepEqual(logs.map((l) => [l.prefix, l.attempt]), [["ghs_", 1], ["ghs_", 2]]);
});

test("the user's own token is 'reconnect' only once GitHub confirms it dead", async () => {
  const dead = deps([personal], "dead");
  await assert.rejects(callWithCredential(where, refusing("gho_mine"), dead.d), GitHubReconnectError);
  assert.deepEqual(dead.logs, [
    { ...where, kind: "personal", prefix: "gho_", ageMinutes: 45, installationId: null, status: 401, attempt: 1, verdict: "dead" },
  ]);
  assert.equal(dead.resolved(), 1, "the user's own isn't asked for twice");

  for (const verdict of ["alive", "unknown"] as const) {
    const { d } = deps([personal], verdict);
    await assert.rejects(
      callWithCredential(where, refusing("gho_mine"), d),
      (e: unknown) => e instanceof GitHubSyncError && !(e instanceof GitHubReconnectError),
      verdict,
    );
  }
});

test("anything but a 401 passes through untouched", async () => {
  const { d, logs } = deps([personal]);
  const rateLimited = new GitHubSyncError("rate limited", 403);
  await assert.rejects(callWithCredential(where, async () => { throw rateLimited; }, d), (e) => e === rateLimited);
  assert.deepEqual(logs, []);
});

test("a credential already resolved is tried first, not resolved again", async () => {
  const { d, resolved } = deps([personal]);
  const given: GitCredential = { ...personal, token: "gho_given" };
  assert.equal(await callWithCredential(where, refusing(), d, given), "ok with gho_given");
  assert.equal(resolved(), 0);
});

test("the App retry is one helper: the user is in its log, and the token that answered is the fresh one", async () => {
  const { d, logs, forgotten } = deps([app("ghs_fresh", 0)]);
  const used: string[] = [];
  const result = await retryInstallationToken(
    { ...where, userId: "u1", orgId: "o1" },
    async (token) => {
      used.push(token);
      return refusing("ghs_stale")(token);
    },
    d,
    app("ghs_stale", 58),
  );
  assert.equal(result, "ok with ghs_fresh");
  assert.deepEqual(used, ["ghs_stale", "ghs_fresh"]);
  assert.deepEqual(forgotten, ["ghs_stale"]);
  assert.deepEqual(logs, [
    { userId: "u1", orgId: "o1", ...where, kind: "installation", prefix: "ghs_", ageMinutes: 58, installationId: 42, status: 401, attempt: 1 },
  ]);
});
