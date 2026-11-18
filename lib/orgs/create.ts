/**
 * Making a team org: the rules, apart from GitHub and the database so they
 * test on their own (wired in app/api/orgs/route.ts).
 *
 * One org per email domain: the org takes the domain of its creator's primary
 * verified email (a free mail provider's never counts; lib/orgs/domains.ts).
 * If an org with people has claimed that domain already, no org is made; the
 * creator is pointed at that one to ask to join instead. One with none left
 * (orgsForDomains leaves it out) gives its domain up to the new org.
 */

import type { DomainOrg } from "@/lib/db/orgs";
import { primaryDomain, type VerifiedEmail } from "@/lib/orgs/domains";

export type CreateTeamOrgDeps = {
  /** The creator's emails GitHub has verified. */
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
  const domain = primaryDomain(await deps.verifiedEmails());
  if (domain) {
    const [existing] = await deps.orgsForDomains([domain]);
    if (existing) return { made: false, existing };
  }
  const orgId = await deps.create({ name, creatorId, domain });
  return { made: true, orgId, domain };
}
