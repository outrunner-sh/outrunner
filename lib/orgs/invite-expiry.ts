/**
 * When an open invite's link stops working, as the members page says it.
 * Pure, for the page and the tests.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** "expires in 6 days", "expires in 3 hours", "expired"; for `expiresAt`
 *  as of `now`. */
export function inviteExpiry(expiresAt: string, now: number): string {
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left) || left <= 0) return "expired";
  if (left >= DAY_MS) {
    const days = Math.round(left / DAY_MS);
    return `expires in ${days} day${days === 1 ? "" : "s"}`;
  }
  const hours = Math.max(1, Math.round(left / (60 * 60 * 1000)));
  return `expires in ${hours} hour${hours === 1 ? "" : "s"}`;
}
