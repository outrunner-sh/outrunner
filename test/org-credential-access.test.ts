import assert from "node:assert/strict";
import { test } from "node:test";

import { memberOrgCredential } from "@/lib/orgs/credential-access";
import type { OrgRole } from "@/lib/orgs/active";

test("two current members can use their org credential, without opening another org's", async () => {
  const roles = new Map<string, OrgRole>([["org-a/admin", "admin"], ["org-a/member", "member"], ["org-b/other", "admin"]]);
  const values = new Map([["org-a", "sealed-a"], ["org-b", "sealed-b"]]);
  const reads: string[] = [];
  const store = {
    async read(orgId: string) { reads.push(orgId); return values.get(orgId); },
    async memberRole(orgId: string, userId: string) { return roles.get(`${orgId}/${userId}`) ?? null; },
  };
  assert.equal(await memberOrgCredential("admin", "org-a", store), "sealed-a");
  assert.equal(await memberOrgCredential("member", "org-a", store), "sealed-a");
  assert.equal(await memberOrgCredential("other", "org-a", store), null);
  assert.equal(await memberOrgCredential("member", "org-b", store), null);
  assert.equal(await memberOrgCredential("other", "org-b", store), "sealed-b");
  assert.deepEqual(reads, ["org-a", "org-a", "org-a", "org-b", "org-b"]);

  roles.delete("org-a/member");
  assert.equal(await memberOrgCredential("member", "org-a", store), null, "membership cannot be cached across uses");
  values.delete("org-a");
  assert.equal(await memberOrgCredential("admin", "org-a", store), undefined, "a disconnected credential cannot be cached");
});

test("removal while credential storage is being read refuses the completed read", async () => {
  let member = true;
  let finish: ((value: string) => void) | undefined;
  const waiting = memberOrgCredential("member", "org-a", {
    read: () => new Promise<string>((resolve) => { finish = resolve; }),
    memberRole: async () => member ? "member" : null,
  });
  member = false;
  finish!("sealed-never-returned");
  assert.equal(await waiting, null);
});

test("no org cannot borrow a shared credential, and failed role checks fail closed", async () => {
  let read = false;
  const store = {
    async read() { read = true; return "sealed"; },
    async memberRole(): Promise<OrgRole | null> { throw new Error("membership unavailable"); },
  };
  assert.equal(await memberOrgCredential("member", undefined, store), null);
  assert.equal(read, false);
  await assert.rejects(memberOrgCredential("member", "org-a", store), /membership unavailable/);
});
