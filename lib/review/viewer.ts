import { getOwnerSafe, type Owner } from "@/lib/auth/owner";
import { triageActor } from "@/lib/db/work-items";
import { getOrgContext } from "@/lib/orgs/server";
import type { TriageActor } from "@/lib/triage/access";

/** Who's looking at the Review tab: signed in, in the org the app shows, with
 *  their access in it. Null signed out or with no org. */
export async function reviewViewer(): Promise<{ owner: Owner; actor: TriageActor; orgName: string } | null> {
  const owner = await getOwnerSafe();
  if (!owner) return null;
  const context = await getOrgContext().catch(() => null);
  if (!context) return null;
  const actor = await triageActor(owner.id, context.active.id).catch(() => null);
  return actor ? { owner, actor, orgName: context.active.name } : null;
}
