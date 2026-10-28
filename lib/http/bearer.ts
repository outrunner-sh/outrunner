import { timingSafeEqual } from "node:crypto";

/** Whether `header` is `Bearer <secret>`, compared in constant time: the
 *  cron's calls (the billing reconciler, the Slack agent's tick). */
export function bearerMatches(header: string | null, secret: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The token in `Authorization: Bearer <token>`, or null. */
export function readBearer(header: string | null): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
  return match ? match[1] : null;
}
