import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { defaultEnvironmentId, getEnvironment } from "@/lib/db/environments";
import { missionName } from "@/lib/missions/rules";
import { missionsFor } from "@/lib/missions/view.deps";
import { activeOrgId } from "@/lib/orgs/server";
import { isSameOriginRequest } from "@/lib/http/guards";
import { createCloudSession, type SessionRequest } from "@/lib/session/create-cloud-session";

export const maxDuration = 60;

/**
 * Start a Mission (docs/missions.md): a cloud session of the chosen project
 * (an `environments` row), set up as any session is, whose box also gets the
 * Mission's tools, notes and instructions (lib/missions/setup.ts). Its first
 * message names it, as a session's does. Claude Code only: the Mission's
 * tools reach its agent through Claude Code's MCP config.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as (SessionRequest & { environmentId?: unknown; projectId?: unknown }) | null;
  // A project, or a repository, whose default project it then is.
  if (body && typeof body.environmentId !== "string" && typeof body.projectId === "string") {
    body.environmentId = (await defaultEnvironmentId(owner.id, body.projectId)) ?? undefined;
  }
  if (!body || typeof body.environmentId !== "string") {
    return NextResponse.json({ error: "Choose a project for the Runner." }, { status: 400 });
  }
  if ((body.agent !== undefined && body.agent !== null && body.agent !== "claude") || body.provider === "codex") {
    return NextResponse.json({ error: "Runners run on Claude Code." }, { status: 400 });
  }
  const environment = await getEnvironment(owner.id, body.environmentId);
  const projectId = environment?.defaultForProjectId ?? environment?.repos[0]?.projectId;
  if (!environment || !projectId) {
    return NextResponse.json({ error: "That project isn't one you can start a Runner in." }, { status: 404 });
  }
  const { environmentId: _, projectId: __, ...session } = body;
  void _;
  void __;
  const prompt = typeof session.prompt === "string" ? session.prompt : "";
  return createCloudSession(owner, projectId, session, {
    kind: "mission",
    environmentId: environment.id,
    ...(prompt.trim() && { title: missionName(prompt) }),
  });
}

/** The owner's Missions in the org the sidebar shows, with their Runners
 *  (lib/missions/view.ts): the sidebar and the Runners pane poll it. */
export async function GET() {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const missions = await missionsFor(owner.id, (await activeOrgId()) ?? null);
  return NextResponse.json({ missions }, { headers: { "cache-control": "no-store" } });
}
