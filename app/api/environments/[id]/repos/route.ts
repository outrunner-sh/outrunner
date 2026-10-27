import { NextResponse } from "next/server";
import { z } from "zod";

import { getOwner } from "@/lib/auth/owner";
import {
  addEnvironmentRepo,
  EnvironmentAccessError,
  getEnvironment,
  removeEnvironmentRepo,
} from "@/lib/db/environments";
import { listProjects } from "@/lib/db/repositories";
import { EnvironmentRuleError, MAX_REPOS } from "@/lib/environments/rules";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";
import { projectLevel } from "@/lib/db/org-access";
import { allows } from "@/lib/orgs/access";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A project's repositories. GET lists the repositories that can be added
 * (the owner's connected ones not in it yet); POST adds one, `{projectId}`;
 * DELETE removes one, `?projectId=`, never the last. The project as it is
 * after. New sessions get the change; running ones keep theirs.
 */

function notFound() {
  return NextResponse.json({ error: "Project not found." }, { status: 404 });
}

async function context_(request: Request, context: RouteContext, write: boolean) {
  if (write && !isSameOriginRequest(request)) {
    return { response: NextResponse.json({ error: "Invalid request origin." }, { status: 403 }) };
  }
  const owner = await getOwner();
  if (!owner) return { response: signInFirst() };
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return { response: notFound() };
  return { owner, id };
}

export async function GET(request: Request, context: RouteContext) {
  const c = await context_(request, context, false);
  if ("response" in c) return c.response;
  const environment = await getEnvironment(c.owner.id, c.id);
  if (!environment) return notFound();
  const inIt = new Set(environment.repos.map((r) => r.projectId));
  // Only the project's org's: a project's repositories are its org's. And
  // only ones the user may write: a project's level is its repositories'
  // lowest, so adding one they only read would leave them unable to change
  // the project again (addEnvironmentRepo refuses it too).
  const candidates = (await listProjects(environment.orgId)).filter((p) => !inIt.has(p.id));
  const levels = await Promise.all(candidates.map((p) => projectLevel(c.owner.id, p.id)));
  const repositories = candidates
    .filter((_, i) => allows(levels[i], "write"))
    .map((p) => ({ projectId: p.id, fullName: p.fullName, defaultBranch: p.defaultBranch, private: p.private }));
  return NextResponse.json({ repositories, max: MAX_REPOS });
}

export async function POST(request: Request, context: RouteContext) {
  const c = await context_(request, context, true);
  if ("response" in c) return c.response;
  const body = z.object({ projectId: z.string().uuid() }).safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Pick a repository to add." }, { status: 400 });
  return savingSettings("project repositories", async () => {
    try {
      await addEnvironmentRepo(c.owner.id, c.id, body.data.projectId);
    } catch (error) {
      if (error instanceof EnvironmentRuleError) return NextResponse.json({ error: error.message }, { status: 400 });
      if (error instanceof EnvironmentAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
    return NextResponse.json(await getEnvironment(c.owner.id, c.id));
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  const c = await context_(request, context, true);
  if ("response" in c) return c.response;
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId || !z.string().uuid().safeParse(projectId).success) {
    return NextResponse.json({ error: "Pick a repository to remove." }, { status: 400 });
  }
  return savingSettings("project repositories", async () => {
    try {
      await removeEnvironmentRepo(c.owner.id, c.id, projectId);
    } catch (error) {
      if (error instanceof EnvironmentRuleError) return NextResponse.json({ error: error.message }, { status: 400 });
      if (error instanceof EnvironmentAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
    return NextResponse.json(await getEnvironment(c.owner.id, c.id));
  });
}
