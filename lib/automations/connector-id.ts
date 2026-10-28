import { createHash } from "node:crypto";

/**
 * The connector's user id, derived from the org's (a name-based UUID): every
 * call that makes it asks for the same user, so two at once, or one after a
 * call that died partway, make one connector and finish its setup.
 */
export function connectorUserId(orgId: string): string {
  const hash = createHash("sha1").update(`outrunner-connector:${orgId}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
