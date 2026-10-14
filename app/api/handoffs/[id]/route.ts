import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { isHandoffId, removeHandoff } from "@/lib/runtime/handoff/storage";
import { supabaseHandoffStorage } from "@/lib/runtime/storage/supabase-adapter";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Throw away a package that won't be used: its upload failed part-way. */
export async function DELETE(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const { id } = await context.params;
  if (!isHandoffId(id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  // Only ever the caller's own: the path is built from their id.
  await removeHandoff(supabaseHandoffStorage(), owner.id, id);
  return new NextResponse(null, { status: 204 });
}
