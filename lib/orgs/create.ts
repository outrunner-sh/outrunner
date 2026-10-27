/**
 * Making a team org: the rules, apart from GitHub and the database so they
 * test on their own (wired in app/api/orgs/route.ts).
 *
 * One org per email domain: the org takes the domain of its creator's primary
 * verified email (a free mail provider's never counts). If an org has already
 * claimed one of the creator's domains, no org is made; they're pointed at
 * that one to ask to join instead.
 */

import type { DomainOrg } from "@/lib/db/orgs";
import { claimableDomains, type VerifiedEmail } from "@/lib/orgs/domains";

export type CreateTeamOrgDeps = {
  /** The creator's emails GitHub has verified, primary first. */
  verifiedEmails(): Promise<VerifiedEmail[]>;
  /** The orgs that have claimed any of these domains. */
  orgsForDomains(domains: string[]): Promise<DomainOrg[]>;
  /** Make the org, its creator its admin, claiming `domain` (or none). */
  create(input: { name: string; creatorId: string; domain: string | null }): Promise<string>;
};

export type CreateTeamOrgOutcome =
  | { made: true; orgId: string; domain: string | null }
  | { made: false; existing: DomainOrg };

export async function createTeamOrgFor(
  creatorId: string,
  name: string,
  deps: CreateTeamOrgDeps,
): Promise<CreateTeamOrgOutcome> {
  const domains = claimableDomains(await deps.verifiedEmails());
  const [existing] = await deps.orgsForDomains(domains);
  if (existing) return { made: false, existing };
  const domain = domains[0] ?? null;
  const orgId = await deps.create({ name, creatorId, domain });
  return { made: true, orgId, domain };
}
