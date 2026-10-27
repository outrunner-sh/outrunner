import { NextResponse } from "next/server";

import { getWorkItem, listNotes, updateWorkItem, WorkItemChangeError } from "@/lib/db/work-items";
import { triageCaller } from "@/lib/triage/caller";
import { parseWorkItemPatch } from "@/lib/triage/work-items";

type RouteContext = { params: Promise<{ id: string }> };

/** One item and its notes, oldest note first. */
export async function GET(request: Request, context: RouteContext) {
  const caller = await triageCaller(request, { allowToken: true });
  if (caller instanceof NextResponse) return caller;
  const { id } = await context.params;
  const item = await getWorkItem(caller.db, caller.owner.id, id);
  if (!item) return NextResponse.json({ error: "Item not found." }, { status: 404 });
  return NextResponse.json({ item, notes: await listNotes(caller.db, caller.owner.id, id) });
}

/** Triage it (accept, decline, duplicate), move it, or edit its title and body. */
export async function PATCH(request: Request, context: RouteContext) {
  const caller = await triageCaller(request);
  if (caller instanceof NextResponse) return caller;
  const patch = parseWorkItemPatch(await request.json().catch(() => null));
  if (typeof patch === "string") return NextResponse.json({ error: patch }, { status: 400 });

  const { id } = await context.params;
  try {
    const item = await updateWorkItem(caller.db, caller.owner.id, id, patch);
    if (!item) return NextResponse.json({ error: "Item not found." }, { status: 404 });
    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof WorkItemChangeError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
