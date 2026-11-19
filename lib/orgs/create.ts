/**
 * Making a team org: the rules, apart from GitHub and the database so they
 * test on their own (wired in app/api/orgs/route.ts).
 *
 * One org per email domain: the org takes the domain of its creator's primary
 * verified email (a free mail provider's never counts; lib/orgs/domains.ts).
 * If an org with people has claimed that domain already, no org is made; the
 * creator is pointed at that one to ask to join instead. One with none left
 * (orgsForDomains leaves it out) gives its domain up to the new org.
 *
 * One Free org per creator, their own org (lib/orgs/own-org.ts) counting:
 * each org has its own Free allowance, so another takes an org they admin on
 * a paid plan (mayMakeAnotherOrg). The database holds the line
 * (20261120130000_own_org_on_sign_in.sql); this says where it is.
 */

import type { PlanId } from "@/lib/billing/plans";
import type { DomainOrg } from "@/lib/db/orgs";
import { primaryDomain, type VerifiedEmail } from "@/lib/orgs/domains";

export type CreateTeamOrgDeps = {
  /** The creator's emails GitHub has verified. */
  verifiedEmails(): Promise<VerifiedEmail[]>;
  /** The orgs that have claimed any of these domains. */
  orgsForDomains(domains: string[]): Promise<DomainOrg[]>;
  /** Whether the creator may make an org beyond their one Free one
   *  (mayMakeAnotherOrg). */
  mayMakeAnother(): Promise<boolean>;
  /** Make the org, its creator its admin, claiming `domain` (or none);
   *  refused when they've made one and `mayMakeAnother` is false. */
  create(input: { name: string; creatorId: string; domain: string | null; mayMakeAnother: boolean }): Promise<string>;
};

export type CreateTeamOrgOutcome =
  | { made: true; orgId: string; domain: string | null }
  | { made: false; existing: DomainOrg };

export async function createTeamOrgFor(
  creatorId: string,
  name: string,
  deps: CreateTeamOrgDeps,
): Promise<CreateTeamOrgOutcome> {
  const domain = primaryDomain(await deps.verifiedEmails());
  if (domain) {
    const [existing] = await deps.orgsForDomains([domain]);
    if (existing) return { made: false, existing };
  }
  const orgId = await deps.create({ name, creatorId, domain, mayMakeAnother: await deps.mayMakeAnother() });
  return { made: true, orgId, domain };
}

/**
 * Whether a creator may make an org beyond their one Free one: with billing
 * off, always (there's no allowance to multiply); else when an org they're
 * an admin of is on a paid plan. `adminOrgPlans` is asked only with billing on.
 */
export async function mayMakeAnotherOrg(billingOff: boolean, adminOrgPlans: () => Promise<PlanId[]>): Promise<boolean> {
  if (billingOff) return true;
  return (await adminOrgPlans()).some((plan) => plan !== "free");
}
