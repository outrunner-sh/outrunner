import { NextResponse } from "next/server";
import { z } from "zod";

import { getOwner } from "@/lib/auth/owner";
import { getWorkspace } from "@/lib/db/repositories";
import { updateMark } from "@/lib/db/session-standing";
import { isSameOriginRequest } from "@/lib/http/guards";
import { MOVABLE_STANDINGS } from "@/lib/session/standing";

type RouteContext = { params: Promise<{ id: string }> };

const MarkChange = z
  .object({
    pinned: z.boolean().optional(),
    /** A group to hold it in; null hands it back to the server's reading. */
    movedTo: z.enum(MOVABLE_STANDINGS).nullable().optional(),
    /** The user has seen it as it is now: its replies are read. */
    seen: z.literal(true).optional(),
  })
  .refine((change) => Object.keys(change).length > 0, "Say what to change.");

/**
 * The user's own marks on one of their sessions: pin it, move it to a group
 * by hand (lib/session/standing.ts), or mark it seen.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const parsed = MarkChange.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That isn't a change to a session's marks." }, { status: 400 });

  const { id } = await context.params;
  // Read as the user: only their own sessions are found.
  const workspace = await getWorkspace(id);
  if (!workspace || workspace.status === "destroyed") {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }
  try {
    await updateMark(owner.id, workspace.id, parsed.data);
  } catch (error) {
    console.error(`Marks: couldn't update ${id}`, error);
    return NextResponse.json({ error: "Couldn't save that. Please try again." }, { status: 500 });
  }
  return NextResponse.json({ result: "saved" });
}
