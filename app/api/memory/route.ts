import { NextResponse } from "next/server";

import { memoryCaller, memoryView } from "@/lib/memory/routes";

/**
 * Settings → Memory: the notes in the signed-in user's long-term memory and
 * their org's (`?org=`), newest first (lib/memory). Agents add them; this
 * lists them, and [id] deletes one.
 */
export async function GET(request: Request) {
  const actor = await memoryCaller(request, new URL(request.url).searchParams.get("org"));
  if (actor instanceof Response) return actor;
  return NextResponse.json({ memories: await memoryView(actor) });
}
