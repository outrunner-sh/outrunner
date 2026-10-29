import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getWorkspace } from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { createSessionPreview, listSessionPreviews } from "@/lib/previews/manage";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A session's previews, for its Environment panel: links on the preview
 * domain to servers on its box, that sign visitors in (lib/previews). Its
 * owner's alone here (the session read as them); the public API also lets
 * the org's admins list and revoke them.
 */
export async function GET(_request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  const listed = await listSessionPreviews({ kind: "user", user: owner }, workspace);
  if (!listed.ok) return NextResponse.json({ error: listed.message }, { status: listed.status });
  return NextResponse.json({ previews: listed.value });
}

/** Make a preview of a port (`{ port, label?, mode? }`), or hand back the
 *  one it has. */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Send the port as JSON." }, { status: 400 });
  const made = await createSessionPreview({ kind: "user", user: owner }, workspace, {
    port: body.port,
    label: body.label,
    mode: body.mode,
  });
  if (!made.ok) return NextResponse.json({ error: made.message }, { status: made.status });
  return NextResponse.json({ preview: made.value }, { status: made.status ?? 200 });
}
