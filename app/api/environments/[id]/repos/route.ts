import { NextResponse } from "next/server";
import { z } from "zod";

import { recordProjectChange } from "@/lib/audit/project-history";
import { getOwner } from "@/lib/auth/owner";
import {
  addEnvironmentRepo,
  EnvironmentAccessError,
  getEnvironment,
  removeEnvironmentRepo,
} from "@/lib/db/environments";
import { EnvironmentRuleError } from "@/lib/environments/rules";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * An environment's repositories. POST adds connected ones, `{projectId}` or
 * several, `{projectIds}` (the repository picker's,
 * components/repository-picker.tsx), in that order; DELETE removes one,
 * `?projectId=`, never the last. The environment as it is after. New
 * sessions get the change; running ones keep theirs.
 */

function notFound() {
  return NextResponse.json({ error: "Environment not found." }, { status: 404 });
}

async function context_(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return { response: NextResponse.json({ error: "Invalid request origin." }, { status: 403 }) };
  }
  const owner = await getOwner();
  if (!owner) return { response: signInFirst() };
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return { response: notFound() };
  return { owner, id };
}

const Add = z.union([
  z.object({ projectId: z.string().uuid() }).transform((b) => [b.projectId]),
  z.object({ projectIds: z.array(z.string().uuid()).min(1) }).transform((b) => [...new Set(b.projectIds)]),
]);

export async function POST(request: Request, context: RouteContext) {
  const c = await context_(request, context);
  if ("response" in c) return c.response;
  const body = Add.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Pick a repository to add." }, { status: 400 });
  const projectIds = body.data;
  return savingSettings("environment repositories", async () => {
    // One at a time, each checked as it's added (addEnvironmentRepo): a
    // refusal part way keeps those added before it, and says why.
    const added: string[] = [];
    let refusal: NextResponse | null = null;
    for (const projectId of projectIds) {
      try {
        await addEnvironmentRepo(c.owner.id, c.id, projectId);
        added.push(projectId);
      } catch (error) {
        if (error instanceof EnvironmentRuleError) refusal = NextResponse.json({ error: error.message }, { status: 400 });
        else if (error instanceof EnvironmentAccessError) refusal = NextResponse.json({ error: error.message }, { status: 403 });
        else throw error;
        break;
      }
    }
    const now = await getEnvironment(c.owner.id, c.id);
    if (now && added.length > 0) {
      const names = added.map((projectId) => now.repos.find((r) => r.projectId === projectId)?.fullName ?? projectId);
      await recordProjectChange(c.owner, c.id, "project.repos_changed", { added: names.join(", ") }, now);
    }
    return refusal ?? NextResponse.json(now);
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  const c = await context_(request, context);
  if ("response" in c) return c.response;
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId || !z.string().uuid().safeParse(projectId).success) {
    return NextResponse.json({ error: "Pick a repository to remove." }, { status: 400 });
  }
  return savingSettings("environment repositories", async () => {
    try {
      const before = await getEnvironment(c.owner.id, c.id);
      await removeEnvironmentRepo(c.owner.id, c.id, projectId);
      const removed = before?.repos.find((r) => r.projectId === projectId)?.fullName ?? projectId;
      if (before) await recordProjectChange(c.owner, c.id, "project.repos_changed", { removed }, before);
    } catch (error) {
      if (error instanceof EnvironmentRuleError) return NextResponse.json({ error: error.message }, { status: 400 });
      if (error instanceof EnvironmentAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
    return NextResponse.json(await getEnvironment(c.owner.id, c.id));
  });
}
