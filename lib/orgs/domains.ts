/**
 * The email domain a team org claims: its creator's, from an email GitHub has
 * verified, and never a free mail provider's. Anyone can have a gmail.com
 * address, so claiming one would let one org stand in the way of every
 * gmail user making their own.
 */

/** Free mail providers and GitHub's own addresses: never claimed. */
const PUBLIC_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "mail.com",
  "hey.com",
  "fastmail.com",
  "qq.com",
  "163.com",
  "126.com",
  "users.noreply.github.com",
]);

/** Prefixes of providers with a domain per country: gmx.de, web.de's peers. */
const PUBLIC_PREFIXES = ["gmx.", "yahoo.", "hotmail.", "outlook.", "live."];

/** The domain of an email, lower case; null for something that isn't one. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

/** Whether a domain is a free mail provider's (or GitHub's), never claimed. */
export function isPublicDomain(domain: string): boolean {
  return PUBLIC_DOMAINS.has(domain) || PUBLIC_PREFIXES.some((prefix) => domain.startsWith(prefix));
}

export type VerifiedEmail = { email: string; primary: boolean };

/**
 * The domains of a user's verified emails an org could claim, their primary
 * email's first: the one a new team org takes. Empty when every one is a
 * free mail provider's.
 */
export function claimableDomains(emails: readonly VerifiedEmail[]): string[] {
  const ordered = [...emails].sort((a, b) => Number(b.primary) - Number(a.primary));
  const domains: string[] = [];
  for (const { email } of ordered) {
    const domain = emailDomain(email);
    if (domain && !isPublicDomain(domain) && !domains.includes(domain)) domains.push(domain);
  }
  return domains;
}
