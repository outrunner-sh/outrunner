import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getWorkspace } from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { nameSessionFromPrompt } from "@/lib/session/name-session";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Name a session that has none from the first prompt of its conversation, as
 * the session page reads it. For sessions whose first prompt was sent before
 * titles were saved: the conversation is on the box, not in the database, so
 * the page that already has it passes it on. Sets a title only where there is
 * none (`where title is null`), so it can never rename a session.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { prompt?: unknown } | null;
  const prompt = typeof body?.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) {
    return NextResponse.json({ error: "A non-empty prompt is required." }, { status: 400 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  return NextResponse.json({ titled: await nameSessionFromPrompt(workspace, prompt) });
}
