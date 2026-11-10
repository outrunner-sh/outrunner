import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getWorkspace, renameWorkspace } from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { nameSessionFromPrompt } from "@/lib/session/name-session";
import { cleanTitle, TITLE_MAX } from "@/lib/nav/session-title";

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

/** Rename a session: the sidebar row's Rename. Only its owner can. */
export async function PATCH(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { title?: unknown } | null;
  const title = cleanTitle(body?.title);
  if (!title) {
    return NextResponse.json({ error: `A title of 1 to ${TITLE_MAX} characters is required.` }, { status: 400 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace || workspace.status === "destroyed") {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }
  try {
    if (!(await renameWorkspace(workspace.id, owner.id, title))) {
      return NextResponse.json({ error: "Only the session's owner can rename it." }, { status: 403 });
    }
  } catch (error) {
    console.error(`Title: couldn't rename ${id}`, error);
    return NextResponse.json({ error: "Couldn't rename this session. Please try again." }, { status: 500 });
  }
  return NextResponse.json({ title });
}
