import assert from "node:assert/strict";
import { test } from "node:test";

import { firstJoined, madeByOthers, orgName, orgSummary, pickActiveOrg, sortOrgs, type Org } from "@/lib/orgs/active";
import { emailDomain, isPublicDomain, primaryDomain } from "@/lib/orgs/domains";

const own: Org = { id: "p", name: "Ada's organization", joinedAt: "2026-10-27T09:00:00Z", role: "admin" };
const team: Org = { id: "t", name: "Initech", joinedAt: "2026-11-01T10:00:00Z", role: "member" };
const other: Org = { id: "a", name: "Acme", joinedAt: "2026-11-02T10:00:00Z", role: "admin" };

test("the active org is the cookie's while the user is a member of it", () => {
  assert.equal(pickActiveOrg([own, team], "t"), team);
});

test("an org the user isn't in (left, removed, or made up) falls back to the one they joined first", () => {
  assert.equal(pickActiveOrg([own, team], "gone"), own);
  assert.equal(pickActiveOrg([team, own], undefined), own);
  assert.equal(pickActiveOrg([team, other], undefined), team);
});

test("no org at all: none", () => {
  assert.equal(pickActiveOrg([], "t"), null);
});

test("orgs list by name", () => {
  assert.deepEqual(
    sortOrgs([team, own, other]).map((o) => o.id),
    ["a", "p", "t"],
  );
});

test("an org's name is trimmed and 1 to 80 characters", () => {
  assert.equal(orgName("  Zero   trail "), "Zero trail");
  assert.equal(orgName(""), null);
  assert.equal(orgName("   "), null);
  assert.equal(orgName("x".repeat(81)), null);
  assert.equal(orgName(42), null);
});

test("an email's domain, lower case; not one for something else", () => {
  assert.equal(emailDomain("Dev@Initech.DEV"), "initech.dev");
  assert.equal(emailDomain("no-at-sign"), null);
  assert.equal(emailDomain("@initech.dev"), null);
  assert.equal(emailDomain("a@localhost"), null);
});

test("free mail providers and GitHub's addresses are never claimed", () => {
  for (const domain of [
    "gmail.com",
    "outlook.com",
    "proton.me",
    "users.noreply.github.com",
    "gmx.de",
    "yahoo.co.uk",
    "web.de",
    "mail.ru",
    "tutanota.com",
    "tuta.io",
    "duck.com",
    "naver.com",
    "rediffmail.com",
  ]) {
    assert.equal(isPublicDomain(domain), true, domain);
  }
  assert.equal(isPublicDomain("initech.dev"), false);
});

test("the domain an org claims is the primary verified email's, never a secondary one's", () => {
  assert.equal(
    primaryDomain([
      { email: "me@side.dev", primary: false },
      { email: "dev@initech.dev", primary: true },
    ]),
    "initech.dev",
  );
  // A primary on free mail claims nothing, even beside a work email left
  // verified from an old job.
  assert.equal(
    primaryDomain([
      { email: "me@gmail.com", primary: true },
      { email: "me@old-job.com", primary: false },
    ]),
    null,
  );
  assert.equal(primaryDomain([{ email: "me@old-job.com", primary: false }]), null);
  assert.equal(primaryDomain([]), null);
});

test("the switcher says the user's part in an org", () => {
  assert.equal(orgSummary({ role: "admin" }), "Admin");
  assert.equal(orgSummary({ role: "member" }), "Member");
});
