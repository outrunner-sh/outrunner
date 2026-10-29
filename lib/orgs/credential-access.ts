import type { OrgRole } from "@/lib/orgs/active";

/** Server-side access to an org's sealed credential material. No role or
 *  result is cached: removal must take effect on the next credential use.
 *  Management continues to use orgCaller({ admin: true }). */
export async function memberOrgCredential<T>(
  userId: string,
  orgId: string | undefined,
  store: {
    read(orgId: string): Promise<T>;
    memberRole(orgId: string, userId: string): Promise<OrgRole | null>;
  },
): Promise<T | null> {
  if (!orgId) return null;
  // Read sealed data first, then check membership. A removal while the read
  // was in flight must not return that data to a now-removed member.
  const sealed = await store.read(orgId);
  return (await store.memberRole(orgId, userId)) ? sealed : null;
}
