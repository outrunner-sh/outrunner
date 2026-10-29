import { NextResponse } from "next/server";
import { z } from "zod";

import { getOwner, type Owner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { signInFirst } from "@/lib/http/settings-save";

/** A project's route's 404: also a project the user can't see. */
export function projectNotFound(): NextResponse {
  return NextResponse.json({ error: "Project not found." }, { status: 404 });
}

/**
 * Who asks about which project, for a route under /api/environments/[id]:
 * the signed-in user and the project's id, or the answer to give instead.
 * A change (`write`) must come from the app's own pages; the ids named in
 * the path must be ids, so a malformed one is a 404, never a database error.
 */
export async function environmentRequest(
  request: Request,
  params: Promise<Record<string, string>>,
  { write = false, ids = ["id"] }: { write?: boolean; ids?: string[] } = {},
): Promise<{ owner: Owner; params: Record<string, string> } | { response: NextResponse }> {
  if (write && !isSameOriginRequest(request)) {
    return { response: NextResponse.json({ error: "Invalid request origin." }, { status: 403 }) };
  }
  const owner = await getOwner();
  if (!owner) return { response: signInFirst() };
  const given = await params;
  if (ids.some((name) => !z.string().uuid().safeParse(given[name]).success)) return { response: projectNotFound() };
  return { owner, params: given };
}
