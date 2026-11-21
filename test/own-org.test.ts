import assert from "node:assert/strict";
import { test } from "node:test";

import { ownOrgName, ownOrgOnSignIn, pickOwnOrg } from "@/lib/orgs/own-org";

test("a user's own org is named after their first name, else their login or email's local part", () => {
  assert.equal(ownOrgName("Immad Sahin"), "Immad's organization");
  assert.equal(ownOrgName("  Ada  "), "Ada's organization");
  assert.equal(ownOrgName("octocat"), "octocat's organization");
  assert.equal(ownOrgName("dev+outrunner@initech.dev"), "dev's organization");
  assert.equal(ownOrgName(""), "My organization");
  assert.equal(ownOrgName("@initech.dev"), "My organization");
});

test("an own org's name stays within the 80 characters an org's name may have", () => {
  const name = ownOrgName("x".repeat(200));
  assert.ok(name.length <= 80, `${name.length}`);
  assert.ok(name.endsWith("'s organization"));
});

test("sign-in makes no own org on the way to an invite: they'll be in its org", () => {
  assert.equal(ownOrgOnSignIn("/invite/abc123"), false);
  assert.equal(ownOrgOnSignIn("/"), true);
  assert.equal(ownOrgOnSignIn("/onboarding"), true);
});

test("a user's own org: their personal org while they have one, else the first they made", () => {
  const personal = { id: "p", personal: true, createdAt: "2026-11-02T00:00:00Z" };
  const first = { id: "f", personal: false, createdAt: "2026-11-01T00:00:00Z" };
  const later = { id: "l", personal: false, createdAt: "2026-11-05T00:00:00Z" };
  assert.equal(pickOwnOrg([later, personal, first]), "p");
  assert.equal(pickOwnOrg([later, first]), "f");
  assert.equal(pickOwnOrg([]), null);
});
