import assert from "node:assert/strict";
import { test } from "node:test";

import { orgName, orgSummary, pickActiveOrg, sortOrgs, type Org } from "@/lib/orgs/active";
import { emailDomain, isPublicDomain, primaryDomain } from "@/lib/orgs/domains";

const personal: Org = { id: "p", name: "Personal", personal: true, role: "admin" };
const team: Org = { id: "t", name: "Zerotrail", personal: false, role: "member" };
const other: Org = { id: "a", name: "Acme", personal: false, role: "admin" };

test("the active org is the cookie's while the user is a member of it", () => {
  assert.equal(pickActiveOrg([personal, team], "t"), team);
});

test("an org the user isn't in (left, removed, or made up) falls back to their personal org", () => {
  assert.equal(pickActiveOrg([personal, team], "gone"), personal);
  assert.equal(pickActiveOrg([team, personal], undefined), personal);
});

test("no personal org: the first; no org at all: none", () => {
  assert.equal(pickActiveOrg([team], undefined), team);
  assert.equal(pickActiveOrg([], "t"), null);
});

test("orgs list the personal one first, then teams by name", () => {
  assert.deepEqual(
    sortOrgs([team, personal, other]).map((o) => o.id),
    ["p", "a", "t"],
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
  assert.equal(emailDomain("Sahin@ZeroTrail.AI"), "zerotrail.ai");
  assert.equal(emailDomain("no-at-sign"), null);
  assert.equal(emailDomain("@zerotrail.ai"), null);
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
  assert.equal(isPublicDomain("zerotrail.ai"), false);
});

test("the domain an org claims is the primary verified email's, never a secondary one's", () => {
  assert.equal(
    primaryDomain([
      { email: "me@side.dev", primary: false },
      { email: "sahin@zerotrail.ai", primary: true },
    ]),
    "zerotrail.ai",
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

test("the switcher says whose an org is, and the user's part in a team's", () => {
  assert.equal(orgSummary({ personal: true, role: "admin" }), "Personal");
  assert.equal(orgSummary({ personal: false, role: "admin" }), "Team · Admin");
  assert.equal(orgSummary({ personal: false, role: "member" }), "Team · Member");
});
