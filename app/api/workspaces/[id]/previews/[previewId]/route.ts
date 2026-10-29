import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getWorkspace } from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { isUuid } from "@/lib/ids";
import { deleteSessionPreview, updateSessionPreview } from "@/lib/previews/manage";

type RouteContext = { params: Promise<{ id: string; previewId: string }> };

async function signedIn(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id, previewId } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace || !isUuid(previewId)) return NextResponse.json({ error: "Preview not found." }, { status: 404 });
  return { owner, workspace, previewId };
}

/** Rename a preview or switch its mode (`{ label?, mode? }`): the panel
 *  asks before it sends `mode: "public"`. */
export async function PATCH(request: Request, context: RouteContext) {
  const found = await signedIn(request, context);
  if (found instanceof Response) return found;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Send the change as JSON." }, { status: 400 });
  const changed = await updateSessionPreview({ kind: "user", user: found.owner }, found.workspace, found.previewId, {
    label: body.label,
    mode: body.mode,
  });
  if (!changed.ok) return NextResponse.json({ error: changed.message }, { status: changed.status });
  return NextResponse.json({ preview: changed.value });
}

/** Delete a preview: its link stops working for everyone. */
export async function DELETE(request: Request, context: RouteContext) {
  const found = await signedIn(request, context);
  if (found instanceof Response) return found;
  const deleted = await deleteSessionPreview({ kind: "user", user: found.owner }, found.workspace, found.previewId);
  if (!deleted.ok) return NextResponse.json({ error: deleted.message }, { status: deleted.status });
  return new Response(null, { status: 204 });
}
