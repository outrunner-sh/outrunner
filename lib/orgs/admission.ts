/**
 * Who is let in at sign-in past the allowlist (RUNTIME_OWNER_GITHUB_LOGIN),
 * apart from GitHub and the database so the rules test on their own (wired in
 * app/auth/callback/route.ts):
 *
 * - Someone already in a team org: let in (app_metadata.outrunner_admitted).
 *   This also mends an accept whose admission didn't save.
 * - Someone with an open invite to one of their verified emails: kept signed
 *   in, but only so far as the invite's page, where accepting it lets them in
 *   (app/api/invites/accept). An invite alone lets no one into the app:
 *   withdrawn, expired or never accepted, it leaves nothing behind.
 * - Someone whose primary email's domain an org has claimed: a request to
 *   join it goes to its admins, and they're told it's waiting. They come in
 *   once it's approved. A domain match alone lets no one in.
 * - Anyone else: not let in, as before.
 */

import type { DomainOrg } from "@/lib/db/orgs";
import type { JoinRequestOutcome } from "@/lib/db/org-members";
import { primaryDomain, type VerifiedEmail } from "@/lib/orgs/domains";

export type AdmissionDeps = {
  /** Whether the user is a member of any team org. */
  inTeamOrg(): Promise<boolean>;
  verifiedEmails(): Promise<VerifiedEmail[]>;
  hasOpenInviteFor(emails: string[]): Promise<boolean>;
  orgsForDomains(domains: string[]): Promise<DomainOrg[]>;
  /** Ask to join `orgId` by `email`. */
  requestToJoin(orgId: string, email: string): Promise<JoinRequestOutcome>;
  /** Let the user in past the allowlist from now on. */
  admit(): Promise<void>;
  /** Tell an org's admins someone asked to join. Best effort. */
  notifyAdmins(org: DomainOrg, email: string): Promise<void>;
};

export type Admission =
  | { kind: "admitted" }
  /** An open invite: as far as its page, to accept it. */
  | { kind: "invited" }
  | { kind: "requested"; org: DomainOrg; outcome: Exclude<JoinRequestOutcome, "member"> }
  | { kind: "refused" };

export async function admitOnSignIn(deps: AdmissionDeps): Promise<Admission> {
  if (await deps.inTeamOrg()) {
    await deps.admit();
    return { kind: "admitted" };
  }
  const emails = await deps.verifiedEmails();
  if (await deps.hasOpenInviteFor(emails.map((e) => e.email))) return { kind: "invited" };
  const domain = primaryDomain(emails);
  const [org] = domain ? await deps.orgsForDomains([domain]) : [];
  if (!org) return { kind: "refused" };
  const email = emails.find((e) => e.primary)!.email;
  const outcome = await deps.requestToJoin(org.id, email);
  if (outcome === "member") {
    await deps.admit();
    return { kind: "admitted" };
  }
  if (outcome === "requested") await deps.notifyAdmins(org, email).catch(() => {});
  return { kind: "requested", org, outcome };
}

/** Whether a path is an invite's page, the one place an invitee not yet let in
 *  may go. */
export function isInvitePath(path: string): boolean {
  return /^\/invite\/[^/?#]+$/.test(path);
}
