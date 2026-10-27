/**
 * The email domain a team org claims: its creator's primary email's, as
 * GitHub has verified it, and never a free mail provider's. Anyone can have a
 * gmail.com address, so claiming one would let one org stand in the way of
 * every gmail user making their own.
 *
 * Only the primary email counts. GitHub never un-verifies an email, so a
 * secondary one may be a job left years ago; the primary is the one its owner
 * says is theirs now.
 */

import freeEmailDomains from "free-email-domains";

/** A maintained list of free mail providers (the free-email-domains package). */
const FREE_DOMAINS: ReadonlySet<string> = new Set(freeEmailDomains);

/** What that list doesn't have: GitHub's own addresses, and a few providers. */
const ALSO_PUBLIC: ReadonlySet<string> = new Set(["users.noreply.github.com", "tutanota.com", "tutanota.de", "tutamail.com"]);

/** The domain of an email, lower case; null for something that isn't one. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

/** Whether a domain is a free mail provider's (or GitHub's), never claimed. */
export function isPublicDomain(domain: string): boolean {
  return FREE_DOMAINS.has(domain) || ALSO_PUBLIC.has(domain);
}

export type VerifiedEmail = { email: string; primary: boolean };

/**
 * The domain a user's org would claim, and is matched against orgs that have:
 * their primary verified email's. Null when it's a free mail provider's, or
 * they have no primary email GitHub has verified.
 */
export function primaryDomain(emails: readonly VerifiedEmail[]): string | null {
  const primary = emails.find((e) => e.primary);
  const domain = primary ? emailDomain(primary.email) : null;
  return domain && !isPublicDomain(domain) ? domain : null;
}
