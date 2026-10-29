/**
 * What the app's memory routes (app/api/memory) share: the signed-in caller
 * as a memory actor in the org the page shows, and the page's list.
 */

import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { memoryStore } from "@/lib/db/memories";
import { memberRole } from "@/lib/db/orgs";
import { isSameOriginRequest } from "@/lib/http/guards";
import { signInFirst } from "@/lib/http/settings-save";
import { isUuid } from "@/lib/ids";
import { listMemories, type Memory, type MemoryActor, memoryRights } from "@/lib/memory/actions";

/** A note as the page lists it, with whether the caller may delete it. */
export type MemoryView = Memory & { canDelete: boolean };

/** The caller in the org `orgId` names, or the answer to give: 403 for
 *  another site, 401 signed out, 404 for an org they aren't in. */
export async function memoryCaller(request: Request, orgId: unknown): Promise<MemoryActor | Response> {
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  if (typeof orgId !== "string" || !isUuid(orgId)) return NextResponse.json({ error: "No such org." }, { status: 404 });
  const role = await memberRole(orgId, owner.id);
  if (!role) return NextResponse.json({ error: "No such org." }, { status: 404 });
  return { userId: owner.id, orgId, role };
}

/** Every note the caller may read in the org, newest first. */
export async function memoryView(actor: MemoryActor): Promise<MemoryView[]> {
  return (await listMemories(actor, memoryStore))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((m) => ({ ...m, canDelete: memoryRights(actor, m).delete }));
}
