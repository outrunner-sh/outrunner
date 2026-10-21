import assert from "node:assert/strict";
import { test } from "node:test";

import { githubAccessReviewUrl, repositoryAccess } from "@/lib/github/access";
import type { GitHubOrgMembership } from "@/lib/github/client";

function org(id: number, login: string, state: "active" | "pending" = "active"): GitHubOrgMembership {
  return { id, login, avatarUrl: `https://avatars/${login}`, state };
}

const BASE = {
  repositories: [{ owner: "Acme" }, { owner: "me" }],
  complete: true,
  ssoPartialOrgIds: [] as number[],
  invitations: [],
};

test("an org whose repos are all missing gets a hint; one with repos listed doesn't (any case)", () => {
  const access = repositoryAccess({
    ...BASE,
    memberships: { canReadOrgs: true, orgs: [org(1, "acme"), org(2, "neevai-labs")] },
  });
  assert.deepEqual(access.hints, [
    { login: "neevai-labs", avatarUrl: "https://avatars/neevai-labs", reason: "no-repos" },
  ]);
  assert.equal(access.needsOrgScope, false);
});

test("from a short listing, a missing org's repos say nothing", () => {
  const access = repositoryAccess({
    ...BASE,
    complete: false,
    memberships: { canReadOrgs: true, orgs: [org(2, "neevai-labs")] },
  });
  assert.deepEqual(access.hints, []);
});

test("single sign-on names its orgs, and one hint stands for those not among the memberships", () => {
  const access = repositoryAccess({
    ...BASE,
    // Single sign-on is said even of an org with repositories listed.
    ssoPartialOrgIds: [1, 99, 98],
    memberships: { canReadOrgs: true, orgs: [org(1, "acme")] },
  });
  assert.deepEqual(access.hints, [
    { login: "acme", avatarUrl: "https://avatars/acme", reason: "sso" },
    { login: null, avatarUrl: null, reason: "sso" },
  ]);
});

test("invitations to orgs and to repositories link to where they're accepted", () => {
  const access = repositoryAccess({
    ...BASE,
    memberships: { canReadOrgs: true, orgs: [org(1, "acme"), org(3, "newco", "pending")] },
    invitations: [{ id: 7, fullName: "friend/tool", avatarUrl: null, inviter: "friend" }],
  });
  assert.deepEqual(
    access.invites.map((i) => [i.name, i.detail, i.acceptUrl]),
    [
      ["newco", "Invited to join the organization", "https://github.com/orgs/newco/invitation"],
      ["friend/tool", "Invited by friend", "https://github.com/friend/tool/invitations"],
    ],
  );
  // A pending org is an invitation, not a missing-repos hint.
  assert.deepEqual(access.hints, []);
});

test("a token without read:org asks for a sign-in; unreadable memberships say nothing", () => {
  assert.equal(repositoryAccess({ ...BASE, memberships: { canReadOrgs: false } }).needsOrgScope, true);
  const unknown = repositoryAccess({ ...BASE, ssoPartialOrgIds: [5], memberships: null });
  assert.equal(unknown.needsOrgScope, false);
  assert.deepEqual(unknown.hints, [{ login: null, avatarUrl: null, reason: "sso" }]);
});

test("the review link goes to Outrunner's own app page when its client id is set", () => {
  assert.equal(githubAccessReviewUrl("Ov23abc"), "https://github.com/settings/connections/applications/Ov23abc");
  assert.equal(githubAccessReviewUrl("  "), "https://github.com/settings/applications");
  assert.equal(githubAccessReviewUrl(undefined), "https://github.com/settings/applications");
});
