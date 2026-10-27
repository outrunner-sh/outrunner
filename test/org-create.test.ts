import assert from "node:assert/strict";
import { test } from "node:test";

import type { DomainOrg } from "@/lib/db/orgs";
import { createTeamOrgFor, type CreateTeamOrgDeps } from "@/lib/orgs/create";
import type { VerifiedEmail } from "@/lib/orgs/domains";

function deps(emails: VerifiedEmail[], claimed: DomainOrg[] = []) {
  const made: Array<{ name: string; creatorId: string; domain: string | null }> = [];
  const asked: string[][] = [];
  const d: CreateTeamOrgDeps = {
    verifiedEmails: async () => emails,
    orgsForDomains: async (domains) => {
      asked.push(domains);
      return claimed.filter((o) => domains.includes(o.domain));
    },
    create: async (input) => {
      made.push(input);
      return "new-org";
    },
  };
  return { d, made, asked };
}

const zerotrail: DomainOrg = { id: "z", name: "Zerotrail", domain: "zerotrail.ai", memberCount: 3 };

test("a team org claims the creator's primary email's domain", async () => {
  const { d, made } = deps([
    { email: "sahin@zerotrail.ai", primary: true },
    { email: "me@side.dev", primary: false },
  ]);
  assert.deepEqual(await createTeamOrgFor("u1", "Zerotrail", d), { made: true, orgId: "new-org", domain: "zerotrail.ai" });
  assert.deepEqual(made, [{ name: "Zerotrail", creatorId: "u1", domain: "zerotrail.ai" }]);
});

test("an org has the creator's domain already: none is made, and they're pointed at it", async () => {
  const { d, made, asked } = deps([{ email: "sahin@zerotrail.ai", primary: true }], [zerotrail]);
  assert.deepEqual(await createTeamOrgFor("u1", "Mine", d), { made: false, existing: zerotrail });
  assert.deepEqual(asked, [["zerotrail.ai"]]);
  assert.deepEqual(made, []);
});

test("a secondary email's domain neither blocks the creator nor is claimed", async () => {
  const { d, made, asked } = deps(
    [
      { email: "me@side.dev", primary: true },
      { email: "sahin@zerotrail.ai", primary: false },
    ],
    [zerotrail],
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
