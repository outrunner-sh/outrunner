/**
 * Sending an open invite again (POST /api/orgs/[id]/invites/[inviteId]/resend).
 * An invite keeps only its token's hash, so its link can't be shown twice:
 * resending rotates the token instead. The invite gets a new one and
 * INVITE_DAYS more from now, and the old link stops working, as its hash is
 * no longer any invite's. Then the new link is emailed to the invitee when
 * the deployment can, or answered for the admin to share.
 *
 * Its admins only, rate limited (each invite, and each org, may be sent only
 * so often, so a button can't be used to spam an inbox), and audit logged.
 * The I/O is behind {@link ResendDeps}, so this tests on its own.
 */

import type { AuditAction, AuditActor } from "@/lib/audit/actions";
import { hashSecret } from "@/lib/auth/cli-login";
import type { OpenInvite } from "@/lib/db/org-members";
import { RateLimiter, type Taken } from "@/lib/http/rate-limit";
import { isUuid } from "@/lib/ids";
import type { OrgRole } from "@/lib/orgs/active";
import { INVITE_DAYS } from "@/lib/orgs/invite-token";

/** An open invite, as rotating it answers it. */
export type ResentInvite = OpenInvite;

export type ResendCaller = { owner: Exclude<AuditActor, "system">; role: OrgRole };

export type ResendDeps = {
  now(): Date;
  newToken(): string;
  /** The org, or null for none. */
  org(orgId: string): Promise<{ name: string } | null>;
  /** Give the org's open invite `tokenHash` and `expiresAt`, so its old link
   *  stops working; null when it has none by that id (used, withdrawn). */
  rotate(input: { orgId: string; inviteId: string; tokenHash: string; expiresAt: string }): Promise<ResentInvite | null>;
  /** The link a token opens. */
  link(token: string): string;
  canSendEmail(): boolean;
  /** Email the invitee their link; whether it went. */
  email(input: { to: string; orgName: string; inviter: string; link: string }): Promise<boolean>;
  audit(event: {
    orgId: string;
    actor: ResendCaller["owner"];
    action: AuditAction;
    resource: { type: string; id: string; label: string };
    details: Record<string, unknown>;
  }): Promise<void>;
  /** Count a resend of `inviteId` in `orgId` against the limits. */
  limit(orgId: string, inviteId: string): Taken;
};

export type ResendAnswer = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};

/** The limits on resending: per invite, 3 in 10 minutes and 10 a day; per
 *  org, 30 an hour. Kept in this process (lib/http/rate-limit.ts). */
export function resendLimiter(): (orgId: string, inviteId: string) => Taken {
  const perInvite = new RateLimiter([
    { ms: 10 * 60_000, max: 3 },
    { ms: 24 * 60 * 60_000, max: 10 },
  ]);
  const perOrg = new RateLimiter([{ ms: 60 * 60_000, max: 30 }]);
  return (orgId, inviteId) => {
    const invite = perInvite.take(`${orgId}:${inviteId}`);
    const org = perOrg.take(orgId);
    if (invite.ok && org.ok) return { ok: true };
    const wait = Math.max(invite.ok ? 0 : invite.retryAfterSeconds, org.ok ? 0 : org.retryAfterSeconds);
    return { ok: false, retryAfterSeconds: wait };
  };
}

/** Resend the org's open invite `inviteId` as `caller`. */
export async function resendInvite(
  input: { orgId: string; inviteId: string; caller: ResendCaller },
  deps: ResendDeps,
): Promise<ResendAnswer> {
  const { orgId, inviteId, caller } = input;
  if (caller.role !== "admin") return { status: 403, body: { error: "Only the org's admins can do that." } };
  if (!isUuid(inviteId)) return { status: 404, body: { error: "No such invite." } };

  const taken = deps.limit(orgId, inviteId);
  if (!taken.ok) {
    return {
      status: 429,
      body: { error: "That invite was sent a lot just now. Wait a few minutes and try again." },
      headers: { "Retry-After": String(taken.retryAfterSeconds) },
    };
  }

  const org = await deps.org(orgId);
  if (!org) return { status: 404, body: { error: "No such org." } };

  const token = deps.newToken();
  const expiresAt = new Date(deps.now().getTime() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const invite = await deps.rotate({ orgId, inviteId, tokenHash: hashSecret(token), expiresAt });
  if (!invite) return { status: 404, body: { error: "That invite was used or withdrawn already." } };

  const link = deps.link(token);
  const emailed = deps.canSendEmail()
    ? await deps.email({ to: invite.email, orgName: org.name, inviter: caller.owner.name, link })
    : false;
  await deps.audit({
    orgId,
    actor: caller.owner,
    action: "invite.resent",
    resource: { type: "invite", id: invite.id, label: invite.email },
    details: { emailed },
  });
  return { status: 200, body: { invite, link, emailed } };
}
