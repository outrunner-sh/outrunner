import { NextResponse } from "next/server";

import { getWorkItem, listNotes, ownsSession, updateWorkItem, WorkItemChangeError } from "@/lib/db/work-items";
import { permissionsFor } from "@/lib/triage/access";
import { triageCaller } from "@/lib/triage/caller";
import { parseWorkItemPatch } from "@/lib/triage/work-items";

type RouteContext = { params: Promise<{ id: string }> };

/** One item the caller may see, with its notes (oldest first) and what they
 *  may do with it. */
export async function GET(request: Request, context: RouteContext) {
  const caller = await triageCaller(request, { allowToken: true });
  if (caller instanceof NextResponse) return caller;
  const { id } = await context.params;
  const item = await getWorkItem(caller.actor, id);
  if (!item) return NextResponse.json({ error: "Item not found." }, { status: 404 });
  const [notes, ownSession] = await Promise.all([
    listNotes(caller.actor, id),
    item.workspaceId ? ownsSession(item.workspaceId, caller.owner.id) : false,
  ]);
  return NextResponse.json({ item: { ...item, can: permissionsFor(caller.actor, item), ownSession }, notes });
}

/** Triage it (accept, decline, duplicate), move it, or edit its title and
 *  body: with write on its workspace (all of them, for an Unsorted one). */
export async function PATCH(request: Request, context: RouteContext) {
  const caller = await triageCaller(request);
  if (caller instanceof NextResponse) return caller;
  const patch = parseWorkItemPatch(await request.json().catch(() => null));
  if (typeof patch === "string") return NextResponse.json({ error: patch }, { status: 400 });

  const { id } = await context.params;
  try {
    const item = await updateWorkItem(caller.actor, id, patch);
    if (!item) return NextResponse.json({ error: "Item not found." }, { status: 404 });
    return NextResponse.json({ item: { ...item, can: permissionsFor(caller.actor, item) } });
  } catch (error) {
    if (error instanceof WorkItemChangeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
