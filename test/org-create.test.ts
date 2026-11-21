import assert from "node:assert/strict";
import { test } from "node:test";

import type { DomainOrg } from "@/lib/db/orgs";
import { createTeamOrgFor, type CreateTeamOrgDeps, mayMakeAnotherOrg } from "@/lib/orgs/create";
import type { VerifiedEmail } from "@/lib/orgs/domains";

function deps(emails: VerifiedEmail[], claimed: DomainOrg[] = [], mayMakeAnother = false) {
  const made: Array<{ name: string; creatorId: string; domain: string | null; mayMakeAnother: boolean }> = [];
  const asked: string[][] = [];
  const d: CreateTeamOrgDeps = {
    verifiedEmails: async () => emails,
    orgsForDomains: async (domains) => {
      asked.push(domains);
      return claimed.filter((o) => domains.includes(o.domain));
    },
    mayMakeAnother: async () => mayMakeAnother,
    create: async (input) => {
      made.push(input);
      return "new-org";
    },
  };
  return { d, made, asked };
}

const initech: DomainOrg = { id: "z", name: "Initech", domain: "initech.dev", memberCount: 3 };

test("a team org claims the creator's primary email's domain", async () => {
  const { d, made } = deps([
    { email: "dev@initech.dev", primary: true },
    { email: "me@side.dev", primary: false },
  ]);
  assert.deepEqual(await createTeamOrgFor("u1", "Initech", d), { made: true, orgId: "new-org", domain: "initech.dev" });
  assert.deepEqual(made, [{ name: "Initech", creatorId: "u1", domain: "initech.dev", mayMakeAnother: false }]);
});

test("an org has the creator's domain already: none is made, and they're pointed at it", async () => {
  const { d, made, asked } = deps([{ email: "dev@initech.dev", primary: true }], [initech]);
  assert.deepEqual(await createTeamOrgFor("u1", "Mine", d), { made: false, existing: initech });
  assert.deepEqual(asked, [["initech.dev"]]);
  assert.deepEqual(made, []);
});

test("a secondary email's domain neither blocks the creator nor is claimed", async () => {
  const { d, made, asked } = deps(
    [
      { email: "me@side.dev", primary: true },
      { email: "dev@initech.dev", primary: false },
    ],
    [initech],
  );
  assert.deepEqual(await createTeamOrgFor("u1", "Side", d), { made: true, orgId: "new-org", domain: "side.dev" });
  assert.deepEqual(asked, [["side.dev"]]);
  assert.equal(made[0]?.domain, "side.dev");
});

test("only free mail: the org is made claiming no domain, and blocks no one", async () => {
  const { d, made, asked } = deps([{ email: "me@gmail.com", primary: true }]);
  assert.deepEqual(await createTeamOrgFor("u1", "Side project", d), { made: true, orgId: "new-org", domain: null });
  assert.deepEqual(asked, []);
  assert.equal(made[0]?.domain, null);
});

test("the database is told whether the creator may make an org beyond their Free one", async () => {
  const { d, made } = deps([{ email: "me@gmail.com", primary: true }], [], true);
  await createTeamOrgFor("u1", "Second", d);
  assert.equal(made[0]?.mayMakeAnother, true);
});

test("another org takes an org the creator admins on a paid plan; with billing off, anyone may", async () => {
  let asked = 0;
  const plans = (ids: Array<"free" | "pro" | "max" | "enterprise">) => async () => {
    asked++;
    return ids;
  };
  assert.equal(await mayMakeAnotherOrg(false, plans([])), false);
  assert.equal(await mayMakeAnotherOrg(false, plans(["free", "free"])), false);
  assert.equal(await mayMakeAnotherOrg(false, plans(["free", "pro"])), true);
  assert.equal(await mayMakeAnotherOrg(false, plans(["enterprise"])), true);
  asked = 0;
  assert.equal(await mayMakeAnotherOrg(true, plans([])), true);
  assert.equal(asked, 0, "billing off: no plan is read");
});
