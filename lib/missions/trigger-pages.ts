/**
 * What a Mission's Triggers pages load (app/(app)/missions/[id]/triggers):
 * the Mission, if the signed-in person can read its project, and what they
 * may do there.
 */

import { getOwnerSafe } from "@/lib/auth/owner";
import { missionLevel } from "@/lib/missions/slack-route.deps";
import { sessionById } from "@/lib/missions/store";
import { allows } from "@/lib/orgs/access";
import { getOrgContext } from "@/lib/orgs/server";
import type { Workspace } from "@/lib/runtime/types";

export type TriggerPageContext = {
  userId: string;
  mission: Workspace & { orgId: string };
  canWrite: boolean;
  isOwner: boolean;
  admin: boolean;
  personal: boolean;
};

/** Null when there's no such Mission for them (or they're signed out:
 *  `signedOut`). */
export async function triggerPageContext(missionId: string): Promise<TriggerPageContext | "signedOut" | null> {
  const owner = await getOwnerSafe();
  if (!owner) return "signedOut";
  const mission = await sessionById(missionId).catch(() => null);
  if (!mission || mission.kind !== "mission" || !mission.orgId || mission.status === "destroyed") return null;
  const level = await missionLevel(owner.id, mission);
  if (!allows(level, "read")) return null;
  const context = await getOrgContext().catch(() => null);
  const membership = context?.orgs.find((o) => o.id === mission.orgId) ?? null;
  return {
    userId: owner.id,
    mission: mission as Workspace & { orgId: string },
    canWrite: allows(level, "write"),
    isOwner: mission.ownerId === owner.id,
    admin: membership?.role === "admin",
    personal: membership?.personal ?? false,
  };
}
