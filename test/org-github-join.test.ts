/** Which team orgs someone can join through their GitHub organizations, and
 *  the check a join makes (lib/orgs/github-join.ts). */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { UserInstallation } from "@/lib/github/user-auth";
import {
  type GitHubJoinDeps,
  githubJoinMatches,
  MEMBERSHIP_CHECKS_AT_ONCE,
  type SourceOrg,
  verifyGithubJoin,
} from "@/lib/orgs/github-join";

const me = { id: 7, login: "grace" };

const install = (id: number, accountLogin: string, extra: Partial<UserInstallation> = {}): UserInstallation => ({
  id,
  accountLogin,
  accountType: "Organization",
  repositorySelection: "all",
  suspendedAt: null,
  accountId: id * 10,
  ...extra,
});

const source = (orgId: string, orgName: string, installationId: number, githubOrg: string, joinViaGithub = true): SourceOrg => ({
  orgId,
  orgName,
  installationId,
  githubOrg,
  joinViaGithub,
});

/** GitHub's answer for each installation's membership check: true, false, or
 *  an error thrown (an outage, a rate limit). */
type Answer = boolean | Error;

function world(input: {
  token?: string | null;
  installations?: UserInstallation[];
  sources?: SourceOrg[];
  memberOf?: string[];
  removedFrom?: string[];
  answers?: Record<number, Answer>;
}) {
  const asked: number[] = [];
  let running = 0;
  let mostAtOnce = 0;
  const deps: GitHubJoinDeps = {
    userToken: async () => (input.token === undefined ? "ghu_token" : input.token),
    githubUser: async (token) => {
      assert.equal(token, "ghu_token");
      return me;
    },
    installations: async () => input.installations ?? [],
    // As the database answers: only the installations asked about.
    sourceOrgsOf: async (ids) => (input.sources ?? []).filter((s) => ids.includes(s.installationId)),
    sourceInstallationsOf: async (orgId) => (input.sources ?? []).filter((s) => s.orgId === orgId),
    standing: async () => ({ memberOf: new Set(input.memberOf ?? []), removedFrom: new Set(input.removedFrom ?? []) }),
    activeMember: async (installationId, _githubOrg, user) => {
      assert.deepEqual(user, me, "asked about the token's GitHub user");
      asked.push(installationId);
      running++;
      mostAtOnce = Math.max(mostAtOnce, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      const answer = input.answers?.[installationId] ?? false;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { deps, asked, mostAtOnce: () => mostAtOnce };
}

test("an active member of a source org's GitHub organization can join it", async () => {
  const { deps } = world({
    installations: [install(1, "acme")],
    sources: [source("org-acme", "Acme", 1, "acme")],
    answers: { 1: true },
  });
  assert.deepEqual(await githubJoinMatches("u1", deps), {
    githubConnected: true,
    matches: [{ orgId: "org-acme", orgName: "Acme", githubOrg: "acme", installationId: 1, canJoin: true }],
  });
});

test("fails closed: a membership GitHub doesn't confirm (pending, 404, 403, an outage) isn't joinable", async () => {
  // The real check answers false for pending, 404 and 403
  // (test/github-installation-owner.test.ts); an outage throws.
  const { deps } = world({
    installations: [install(1, "pending"), install(2, "outage")],
    sources: [source("org-p", "Pending Co", 1, "pending"), source("org-o", "Outage Co", 2, "outage")],
    answers: { 1: false, 2: new Error("GitHub answered 502") },
  });
  const { matches } = await githubJoinMatches("u1", deps);
  assert.deepEqual(
    matches.map((m) => [m.orgName, m.canJoin, m.why]),
    [
      ["Outage Co", false, "unverified"],
      ["Pending Co", false, "unverified"],
    ],
  );
});

test("orgs they're in already, installations shared from elsewhere, and user accounts' aren't offered", async () => {
  const { deps, asked } = world({
    installations: [
      install(1, "acme"),
      install(2, "shared"),
      install(3, "grace", { accountType: "User" }),
      install(4, "frozen", { suspendedAt: "2026-11-01T00:00:00Z" }),
    ],
    // Installation 2's source org isn't in the database's answer: it's
    // shared into some org, which is no source.
    sources: [source("org-acme", "Acme", 1, "acme"), source("org-grace", "Grace's", 3, "grace"), source("org-frozen", "Frozen", 4, "frozen")],
    memberOf: ["org-acme"],
    answers: { 1: true, 2: true, 3: true, 4: true },
  });
  assert.deepEqual(await githubJoinMatches("u1", deps), { githubConnected: true, matches: [] });
  assert.deepEqual(asked, [], "nothing to ask GitHub");
});

test("an org whose admins turned it off, or that removed them, shows why, without asking GitHub", async () => {
  const { deps, asked } = world({
    installations: [install(1, "closed"), install(2, "removed")],
    sources: [source("org-c", "Closed", 1, "closed", false), source("org-r", "Removed", 2, "removed")],
    removedFrom: ["org-r"],
    answers: { 1: true, 2: true },
  });
  const { matches } = await githubJoinMatches("u1", deps);
  assert.deepEqual(
    matches.map((m) => [m.orgName, m.canJoin, m.why]),
    [
      ["Closed", false, "disabled"],
      ["Removed", false, "removed"],
    ],
  );
  assert.deepEqual(asked, []);
});

test("several matches come by org name, one each, at most MEMBERSHIP_CHECKS_AT_ONCE asked at a time", async () => {
  const names = ["Zeta", "alpha", "Mu", "Beta", "Kappa", "Delta"];
  const { deps, asked, mostAtOnce } = world({
    installations: names.map((n, i) => install(i + 1, n.toLowerCase())),
    sources: [
      ...names.map((n, i) => source(`org-${n}`, n, i + 1, n.toLowerCase())),
      // Mu is also the source of a second GitHub organization's installation,
      // which GitHub confirms where the first it doesn't.
      source("org-Mu", "Mu", 7, "mu-labs"),
    ],
    answers: { 1: true, 2: true, 3: false, 4: true, 5: true, 6: true, 7: true },
  });
  deps.installations = async () => [...names.map((n, i) => install(i + 1, n.toLowerCase())), install(7, "mu-labs")];
  const { matches } = await githubJoinMatches("u1", deps);
  assert.deepEqual(
    matches.map((m) => `${m.orgName}:${m.githubOrg}:${m.canJoin}`),
    ["alpha:alpha:true", "Beta:beta:true", "Delta:delta:true", "Kappa:kappa:true", "Mu:mu-labs:true", "Zeta:zeta:true"],
  );
  assert.equal(asked.length, 7);
  assert.equal(mostAtOnce(), MEMBERSHIP_CHECKS_AT_ONCE);
});

test("without a GitHub connection: no matches, and a flag to connect", async () => {
  const { deps, asked } = world({ token: null, installations: [install(1, "acme")], sources: [source("o", "Acme", 1, "acme")] });
  assert.deepEqual(await githubJoinMatches("u1", deps), { matches: [], githubConnected: false });
  assert.deepEqual(asked, []);
});

test("joining asks GitHub again, for that org's own source installations only", async () => {
  const sources = [source("org-acme", "Acme", 1, "acme"), source("org-acme", "Acme", 2, "acme-labs"), source("org-other", "Other", 3, "other")];
  const yes = world({ sources, answers: { 1: false, 2: true, 3: true } });
  assert.deepEqual(await verifyGithubJoin("u1", "org-acme", yes.deps), { ok: true, githubOrg: "acme-labs", installationId: 2 });
  assert.deepEqual(yes.asked, [1, 2], "never another org's installation");

  const no = world({ sources, answers: { 1: false, 2: new Error("rate-limited"), 3: true } });
  assert.deepEqual(await verifyGithubJoin("u1", "org-acme", no.deps), { ok: false, reason: "unverified" });
  assert.deepEqual(await verifyGithubJoin("u1", "org-none", no.deps), { ok: false, reason: "unverified" }, "an org with no source installation");
  assert.deepEqual(await verifyGithubJoin("u1", "org-acme", world({ token: null, sources }).deps), { ok: false, reason: "not_connected" });
});
