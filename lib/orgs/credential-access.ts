import type { OrgRole } from "@/lib/orgs/active";

/** Read a sealed credential snapshot, then check current membership without
 * caching either result. Sequencing narrows the removal window during the
 * read; membership can still change after the lookup, and this cannot revoke
 * an API key already copied to a computer. Codex broker grants separately use
 * the atomic codex_connection_use check on every request, including after
 * renewal. Management continues to use orgCaller({ admin: true }). */
export async function memberOrgCredential<T>(
  userId: string,
  orgId: string | undefined,
  store: {
    read(orgId: string): Promise<T>;
    memberRole(orgId: string, userId: string): Promise<OrgRole | null>;
  },
): Promise<T | null> {
  if (!orgId) return null;
  // A completed removal during this read is caught by the following lookup.
  const sealed = await store.read(orgId);
  return (await store.memberRole(orgId, userId)) ? sealed : null;
}
