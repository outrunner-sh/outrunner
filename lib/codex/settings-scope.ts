import type { Org } from "@/lib/orgs/active";

/** Page ownership is explicit. An active org must not change Personal, and
 * a removed/unknown org must never fall back to a personal connection. */
export function codexSettingsScope(
  orgs: readonly Org[],
  requestedOrg?: string,
): { kind: "personal" } | { kind: "org"; org: Org } | { kind: "unavailable" } {
  if (requestedOrg === undefined) return { kind: "personal" };
  const org = orgs.find((candidate) => candidate.id === requestedOrg);
  return org ? { kind: "org", org } : { kind: "unavailable" };
}
