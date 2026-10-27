import { NextResponse } from "next/server";

import { addNote, getWorkItem } from "@/lib/db/work-items";
import { triageCaller } from "@/lib/triage/caller";
import { parseNoteBody, type WorkItemSource } from "@/lib/triage/work-items";

type RouteContext = { params: Promise<{ id: string }> };

/** Add a note (Markdown) to an item: from the app, or with a CLI token. */
export async function POST(request: Request, context: RouteContext) {
  const caller = await triageCaller(request, { allowToken: true });
  if (caller instanceof NextResponse) return caller;
  const raw = (await request.json().catch(() => null)) as { body?: unknown; source?: unknown } | null;
  const body = parseNoteBody(raw?.body);
  if (!body) return NextResponse.json({ error: "A note needs some text." }, { status: 400 });
  // A token may say it's a script ("api") rather than the CLI, as a capture can.
  const source = raw?.source === undefined ? caller.sources[0] : raw.source;
  if (typeof source !== "string" || !(caller.sources as readonly string[]).includes(source)) {
    return NextResponse.json({ error: `The source must be one of: ${caller.sources.join(", ")}.` }, { status: 400 });
  }

  const { id } = await context.params;
  const item = await getWorkItem(caller.db, caller.owner.id, id);
  if (!item) return NextResponse.json({ error: "Item not found." }, { status: 404 });
  const note = await addNote(caller.db, caller.owner.id, item.id, { body, source: source as WorkItemSource });
  return NextResponse.json({ note }, { status: 201 });
}
