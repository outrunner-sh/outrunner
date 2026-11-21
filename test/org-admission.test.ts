import assert from "node:assert/strict";
import { test } from "node:test";

import type { DomainOrg } from "@/lib/db/orgs";
import type { JoinRequestOutcome } from "@/lib/db/org-members";
import { admitOnSignIn, type AdmissionDeps, isInvitePath } from "@/lib/orgs/admission";
import type { VerifiedEmail } from "@/lib/orgs/domains";

const initech: DomainOrg = { id: "z", name: "Initech", domain: "initech.dev", memberCount: 3 };

function deps(opts: {
  emails: VerifiedEmail[];
  invited?: boolean;
  claimed?: DomainOrg[];
  outcome?: JoinRequestOutcome;
  member?: boolean;
}) {
  const log: string[] = [];
  const d: AdmissionDeps = {
    inOrgMadeByOthers: async () => opts.member ?? false,
    verifiedEmails: async () => opts.emails,
    hasOpenInviteFor: async (emails) => {
      log.push(`invites? ${emails.join(",")}`);
      return opts.invited ?? false;
    },
    orgsForDomains: async (domains) => (opts.claimed ?? []).filter((o) => domains.includes(o.domain)),
    requestToJoin: async (orgId, email) => {
      log.push(`request ${orgId} ${email}`);
      return opts.outcome ?? "requested";
    },
    admit: async () => {
      log.push("admit");
    },
    notifyAdmins: async (org) => {
      log.push(`notify ${org.id}`);
    },
  };
  return { d, log };
}

test("an open invite to any verified email gets them to its page, and lets them in no further", async () => {
  const { d, log } = deps({
    emails: [
      { email: "me@gmail.com", primary: true },
      { email: "dev@initech.dev", primary: false },
    ],
    invited: true,
    claimed: [initech],
  });
  assert.deepEqual(await admitOnSignIn(d), { kind: "invited" });
  assert.deepEqual(log, ["invites? me@gmail.com,dev@initech.dev"]);
});

test("already in a team org: let in, whatever their emails", async () => {
  const { d, log } = deps({ emails: [{ email: "me@gmail.com", primary: true }], member: true });
  assert.deepEqual(await admitOnSignIn(d), { kind: "admitted" });
  assert.deepEqual(log, ["admit"]);
});

test("an invite's page is the one path an invitee may go to", () => {
  assert.equal(isInvitePath("/invite/or_inv_abc"), true);
  for (const path of ["/", "/invite", "/invite/", "/invite/a/b", "/settings", "/invite/a?x=1"]) {
    assert.equal(isInvitePath(path), false, path);
  }
});

test("a primary email on a claimed domain asks that org to join, and tells its admins", async () => {
  const { d, log } = deps({ emails: [{ email: "new@initech.dev", primary: true }], claimed: [initech] });
  assert.deepEqual(await admitOnSignIn(d), { kind: "requested", org: initech, outcome: "requested" });
  assert.deepEqual(log, ["invites? new@initech.dev", "request z new@initech.dev", "notify z"]);
});

test("asking again while one waits tells the admins nothing new", async () => {
  const { d, log } = deps({
    emails: [{ email: "new@initech.dev", primary: true }],
    claimed: [initech],
    outcome: "pending",
  });
  assert.deepEqual(await admitOnSignIn(d), { kind: "requested", org: initech, outcome: "pending" });
  assert.equal(log.includes("notify z"), false);
});

test("already a member of the domain's org: let in", async () => {
  const { d, log } = deps({
    emails: [{ email: "new@initech.dev", primary: true }],
    claimed: [initech],
    outcome: "member",
  });
  assert.deepEqual(await admitOnSignIn(d), { kind: "admitted" });
  assert.equal(log.at(-1), "admit");
});

test("a secondary email's claimed domain, or no claimed domain: not let in", async () => {
  for (const emails of [
    [
      { email: "me@gmail.com", primary: true },
      { email: "old@initech.dev", primary: false },
    ],
    [{ email: "someone@elsewhere.dev", primary: true }],
  ]) {
    const { d, log } = deps({ emails, claimed: [initech] });
    assert.deepEqual(await admitOnSignIn(d), { kind: "refused" });
    assert.equal(log.includes("admit"), false);
  }
});
