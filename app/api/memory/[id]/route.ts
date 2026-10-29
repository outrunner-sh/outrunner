import { NextResponse } from "next/server";

import { memoryStore } from "@/lib/db/memories";
import { savingSettings } from "@/lib/http/settings-save";
import { deleteMemory, MemoryError } from "@/lib/memory/actions";
import { memoryCaller, memoryView } from "@/lib/memory/routes";

type RouteContext = { params: Promise<{ id: string }> };

/** Delete a note from Settings → Memory (`?org=` the org the page shows):
 *  one's own, or as an admin, any the org shares. Answers with the list. */
export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const actor = await memoryCaller(request, new URL(request.url).searchParams.get("org"));
  if (actor instanceof Response) return actor;
  return savingSettings("memory", async () => {
    try {
      await deleteMemory(actor, memoryStore, id);
    } catch (error) {
      if (error instanceof MemoryError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
    return NextResponse.json({ memories: await memoryView(actor) });
  });
}
