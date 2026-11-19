import assert from "node:assert/strict";
import { test } from "node:test";

import { ownOrgName, ownOrgOnSignIn } from "@/lib/orgs/own-org";

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
