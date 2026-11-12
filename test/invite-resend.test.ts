import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { hashSecret } from "@/lib/auth/cli-login";
import { inviteExpiry } from "@/lib/orgs/invite-expiry";
import {
  INVITE_DAYS,
  newInviteToken,
  resendInvite,
  resendLimiter,
  type ResendCaller,
  type ResendDeps,
  type ResentInvite,
} from "@/lib/orgs/invite-resend";

const ORG = "11111111-1111-4111-8111-111111111111";
const INVITE = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-12T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const admin: ResendCaller = {
  owner: { id: "u1", githubLogin: "ada", name: "Ada", email: "ada@acme.dev" },
  role: "admin",
};

type Row = ResentInvite & { orgId: string; tokenHash: string; acceptedAt: string | null; revokedAt: string | null };

/** An org with one open invite, kept as the table keeps it (the token's
 *  hash), and the link's token it was made with. */
function world(opts: { canSend: boolean; emailWorks?: boolean; personal?: boolean; expired?: boolean }) {
  const oldToken = newInviteToken();
  const row: Row = {
    id: INVITE,
    orgId: ORG,
    email: "grace@acme.dev",
    role: "member",
    invitedBy: "u1",
    createdAt: new Date(NOW.getTime() - 8 * DAY).toISOString(),
    expiresAt: new Date(NOW.getTime() + (opts.expired ? -DAY : 2 * DAY)).toISOString(),
    expired: Boolean(opts.expired),
    tokenHash: hashSecret(oldToken),
    acceptedAt: null,
    revokedAt: null,
  };
  const emails: { to: string; orgName: string; inviter: string; link: string }[] = [];
  const audits: unknown[] = [];
  let tokens = 0;
  const deps: ResendDeps = {
    now: () => NOW,
    newToken: () => `or_inv_new${++tokens}`,
    org: async (id) => (id === ORG ? { name: "Acme", personal: Boolean(opts.personal) } : null),
    rotate: async ({ orgId, inviteId, tokenHash, expiresAt }) => {
      if (row.orgId !== orgId || row.id !== inviteId || row.acceptedAt || row.revokedAt) return null;
      row.tokenHash = tokenHash;
      row.expiresAt = expiresAt;
      row.expired = false;
      return { ...row };
    },
    link: (token) => `https://app.outrunner.sh/invite/${token}`,
    canSendEmail: () => opts.canSend,
    email: async (input) => {
      emails.push(input);
      return opts.emailWorks ?? true;
    },
    audit: async (event) => {
      audits.push(event);
    },
    limit: () => ({ ok: true }),
  };
  /** Whether a link's token would be accepted, as accept_org_invite checks
   *  it: by its hash, open, not past its expiry. */
  const accepts = (token: string) =>
    row.tokenHash === hashSecret(token) && !row.acceptedAt && !row.revokedAt && Date.parse(row.expiresAt) > NOW.getTime();
  return { row, oldToken, deps, emails, audits, accepts };
}

test("only an admin may resend", async () => {
  const w = world({ canSend: true });
  const answer = await resendInvite({ orgId: ORG, inviteId: INVITE, caller: { ...admin, role: "member" } }, w.deps);
  assert.equal(answer.status, 403);
  assert.equal(w.emails.length, 0);
  assert.ok(w.accepts(w.oldToken), "the old link still works");
  // The route asks for an admin before it gets here too.
  const route = readFileSync(path.join(process.cwd(), "app/api/orgs/[id]/invites/[inviteId]/resend/route.ts"), "utf8");
  assert.match(route, /orgCaller\(request, id, \{ admin: true \}\)/);
});

test("resending rotates the token: a new link, 7 days from now, and the old link refused", async () => {
  const w = world({ canSend: false, expired: true });
  assert.equal(w.accepts(w.oldToken), false);
  const answer = await resendInvite({ orgId: ORG, inviteId: INVITE, caller: admin }, w.deps);
  assert.equal(answer.status, 200);
  const link = answer.body.link as string;
  assert.equal(link, "https://app.outrunner.sh/invite/or_inv_new1");
  assert.equal(w.row.tokenHash, hashSecret("or_inv_new1"));
  assert.equal(w.row.expiresAt, new Date(NOW.getTime() + INVITE_DAYS * DAY).toISOString());
  assert.equal(w.accepts("or_inv_new1"), true);
  assert.equal(w.accepts(w.oldToken), false, "the old link stops working");
  assert.equal((answer.body.invite as ResentInvite).expired, false);

  // Again: the link before is refused too.
  await resendInvite({ orgId: ORG, inviteId: INVITE, caller: admin }, w.deps);
  assert.equal(w.accepts("or_inv_new1"), false);
  assert.equal(w.accepts("or_inv_new2"), true);
});

test("without email configured: nothing is sent, and the new link is answered to share", async () => {
  const w = world({ canSend: false });
  const answer = await resendInvite({ orgId: ORG, inviteId: INVITE, caller: admin }, w.deps);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.emailed, false);
  assert.equal(w.emails.length, 0);
  assert.deepEqual(w.audits, [
    {
      orgId: ORG,
      actor: admin.owner,
      action: "invite.resent",
      resource: { type: "invite", id: INVITE, label: "grace@acme.dev" },
      details: { emailed: false },
    },
  ]);
});

test("with email configured: the new link is emailed to the invitee", async () => {
  const w = world({ canSend: true });
  const answer = await resendInvite({ orgId: ORG, inviteId: INVITE, caller: admin }, w.deps);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.emailed, true);
  assert.deepEqual(w.emails, [
    { to: "grace@acme.dev", orgName: "Acme", inviter: "Ada", link: "https://app.outrunner.sh/invite/or_inv_new1" },
  ]);
  assert.deepEqual((w.audits[0] as { details: unknown }).details, { emailed: true });
});

test("an email Resend refused says so, for the admin to share the link", async () => {
  const w = world({ canSend: true, emailWorks: false });
  const answer = await resendInvite({ orgId: ORG, inviteId: INVITE, caller: admin }, w.deps);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.emailed, false);
  assert.equal(typeof answer.body.link, "string");
});

test("a used or withdrawn invite, a bad id, or a personal org: nothing rotates", async () => {
  const used = world({ canSend: true });
  used.row.acceptedAt = NOW.toISOString();
  assert.equal((await resendInvite({ orgId: ORG, inviteId: INVITE, caller: admin }, used.deps)).status, 404);
  assert.equal(used.emails.length, 0);
  assert.equal(used.audits.length, 0);

  const bad = world({ canSend: true });
  assert.equal((await resendInvite({ orgId: ORG, inviteId: "nope", caller: admin }, bad.deps)).status, 404);

  const personal = world({ canSend: true, personal: true });
  assert.equal((await resendInvite({ orgId: ORG, inviteId: INVITE, caller: admin }, personal.deps)).status, 409);
  assert.ok(personal.accepts(personal.oldToken));
});

test("rate limited: 3 resends of an invite in 10 minutes, then 429 with Retry-After", async () => {
  const w = world({ canSend: true });
  w.deps.limit = resendLimiter();
  for (let i = 0; i < 3; i++) {
    assert.equal((await resendInvite({ orgId: ORG, inviteId: INVITE, caller: admin }, w.deps)).status, 200);
  }
  const refused = await resendInvite({ orgId: ORG, inviteId: INVITE, caller: admin }, w.deps);
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers?.["Retry-After"]) > 0);
  assert.equal(w.emails.length, 3, "nothing sent once limited");
  assert.equal(w.accepts("or_inv_new3"), true, "and the last link still works");
});

test("the limiter: per invite, and per org across its invites", () => {
  const take = resendLimiter();
  for (let i = 0; i < 3; i++) assert.equal(take(ORG, "a").ok, true);
  assert.equal(take(ORG, "a").ok, false);
  assert.equal(take(ORG, "b").ok, true, "another invite has its own count");
  const org = resendLimiter();
  for (let i = 0; i < 30; i++) assert.equal(org("o", `i${i}`).ok, true);
  assert.equal(org("o", "i-last").ok, false, "30 an hour across an org");
});

test("rotation is in place: the row keeps its id, takes the new hash and expiry, only while open", () => {
  const source = readFileSync(path.join(process.cwd(), "lib/db/org-members.ts"), "utf8");
  const rotate = source.slice(source.indexOf("export async function rotateInvite"), source.indexOf("export async function revokeInvite"));
  assert.match(rotate, /\.update\(\{ token_hash: input\.tokenHash, expires_at: input\.expiresAt \}\)/);
  assert.match(rotate, /\.is\("accepted_at", null\)\s*\.is\("revoked_at", null\)/);
  // Accepting looks the invite up by its token's hash.
  const migration = readFileSync(path.join(process.cwd(), "supabase/migrations/20261028130000_org_members.sql"), "utf8");
  assert.match(migration, /from organization_invites where token_hash = invite_token_hash/);
});

test("an invite's expiry, as the members page says it", () => {
  const now = NOW.getTime();
  assert.equal(inviteExpiry(new Date(now + 7 * DAY).toISOString(), now), "expires in 7 days");
  assert.equal(inviteExpiry(new Date(now + DAY).toISOString(), now), "expires in 1 day");
  assert.equal(inviteExpiry(new Date(now + 3 * 60 * 60 * 1000).toISOString(), now), "expires in 3 hours");
  assert.equal(inviteExpiry(new Date(now + 60_000).toISOString(), now), "expires in 1 hour");
  assert.equal(inviteExpiry(new Date(now - 1).toISOString(), now), "expired");
});
