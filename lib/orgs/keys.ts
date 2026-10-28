/**
 * How an org's keys meet a member's own (lib/db/org-credentials.ts): the
 * member's always win; the org's fill in for a provider they have none for.
 */

/** Fill `own` (sealed keys by provider; null or absent for none) from
 *  `org`'s where the member has none; the providers it filled. */
export function fillFromOrg(own: Map<string, string | null>, org: ReadonlyMap<string, string>): Set<string> {
  const filled = new Set<string>();
  for (const [provider, key] of org) {
    if (!own.get(provider)) {
      own.set(provider, key);
      filled.add(provider);
    }
  }
  return filled;
}
