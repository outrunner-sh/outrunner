import { after, NextResponse } from "next/server";

import { EnvironmentAccessError } from "@/lib/db/environments";
import { enableEnvironmentSkill, listEnvironmentSkills, SkillConflictError } from "@/lib/db/environment-skills";
import { EnvironmentRuleError } from "@/lib/environments/rules";
import { catalogSkill } from "@/lib/environments/skills";
import { environmentRequest, projectNotFound } from "@/lib/http/environment-request";
import { savingSettings } from "@/lib/http/settings-save";
import { refillAfterChange } from "@/lib/runtime/warm-pool.deps";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A project's skills. GET lists the skills.sh catalog skills enabled on it
 * and its registries (without reading GitHub: skill-registries does); POST
 * enables a catalog skill, `{name, slug, source}` as the search found it.
 * New sessions get them; running ones keep what they started with.
 */

export async function GET(request: Request, context: RouteContext) {
  const c = await environmentRequest(request, context.params);
  if ("response" in c) return c.response;
  const listed = await listEnvironmentSkills(c.owner.id, c.params.id);
  if (!listed) return projectNotFound();
  return NextResponse.json({ skills: listed.skills, registries: listed.registries });
}

export async function POST(request: Request, context: RouteContext) {
  const c = await environmentRequest(request, context.params, { write: true });
  if ("response" in c) return c.response;
  const { id } = c.params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  return savingSettings("project skills", async () => {
    if (!(await listEnvironmentSkills(c.owner.id, id))) return projectNotFound();
    try {
      const skill = await enableEnvironmentSkill(c.owner.id, id, catalogSkill(body ?? {}));
      // Ready boxes were made without it: made again.
      after(() => refillAfterChange(c.owner.id, id));
      return NextResponse.json({ skill }, { status: 201 });
    } catch (error) {
      if (error instanceof EnvironmentRuleError) return NextResponse.json({ error: error.message }, { status: 400 });
      if (error instanceof SkillConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
      if (error instanceof EnvironmentAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
  });
}
