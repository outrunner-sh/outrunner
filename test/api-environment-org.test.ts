import assert from "node:assert/strict";
import { test } from "node:test";

import { projectOutsideOrg } from "@/lib/api/environment-org";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ENV = "33333333-3333-4333-8333-333333333333";
const caller = { caller: { kind: "org_key" as const, userId: "maker", orgId: ORG_A, role: "admin" as const, keyId: "k", cliTokenId: null } };

test("a project of the call's org is let through", async () => {
  assert.equal(await projectOutsideOrg(caller, ENV, async () => ({ orgId: ORG_A })), null);
});

test("a project of another of the maker's orgs is no project of the key's", async () => {
  const refused = await projectOutsideOrg(caller, ENV, async () => ({ orgId: ORG_B }));
  assert.equal(refused?.status, 404);
});

test("a project the maker can't see is a 404", async () => {
  const refused = await projectOutsideOrg(caller, ENV, async () => null);
  assert.equal(refused?.status, 404);
});

test("what isn't an id is left to the endpoint to answer, unlooked up", async () => {
  let asked = false;
  assert.equal(await projectOutsideOrg(caller, "nope", async () => ((asked = true), null)), null);
  assert.equal(asked, false);
});
