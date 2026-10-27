import type { Org } from "@/lib/orgs/active";

/** An org's mark when it has no picture: the first letter of its name. */
export function orgInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase() : "?";
}

/** Tints an org's mark can take: dark enough for white type, each its own. */
export const ORG_TINTS = ["#0f766e", "#1d4ed8", "#7c3aed", "#be185d", "#b45309", "#15803d", "#0369a1", "#9f1239"] as const;

/** An org's tint, the same for it everywhere and every time: from its id. */
export function orgTint(id: string): (typeof ORG_TINTS)[number] {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return ORG_TINTS[Math.abs(hash) % ORG_TINTS.length];
}

/** The line under an org's name in the switcher: whose it is, and the
 *  user's part in a team's. */
export function orgSummary(org: Pick<Org, "personal" | "role">): string {
  if (org.personal) return "Personal";
  return org.role === "admin" ? "Team · Admin" : "Team · Member";
}
