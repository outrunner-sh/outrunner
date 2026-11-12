import { NextResponse } from "next/server";

import { after } from "@/lib/observability/after";

import { EnvironmentAccessError } from "@/lib/db/environments";
import { addSkillRegistry, listEnvironmentSkills, SkillConflictError } from "@/lib/db/environment-skills";
import { EnvironmentRuleError } from "@/lib/environments/rules";
import { registryRepo } from "@/lib/environments/skills";
import { repositorySource, type SourceAccess } from "@/lib/github/repository-source";
import { publicRepository, registrySkills } from "@/lib/github/skills";
import { githubErrorResponse } from "@/lib/github/http";
import { environmentRequest, projectNotFound } from "@/lib/http/environment-request";
import { savingSettings } from "@/lib/http/settings-save";
import { allows } from "@/lib/orgs/access";
import { refillAfterChange } from "@/lib/runtime/warm-pool.deps";

type RouteContext = { params: Promise<{ id: string }> };

// Each registry's skills are read from GitHub, a few calls apiece.
export const maxDuration = 60;

/**
 * A project's skill registries: GitHub repositories whose every skill a new
 * session installs. GET lists them with the skills GitHub shows in each now
 * (`error` for one it wouldn't list); POST adds one, `{url}` (owner/name or
 * its github.com address). A public repository is read by anyone; a private
 * one only through the org's GitHub App, whose token for it reads that one
 * repository and nothing else: a member's own sign-in reads all they can,
 * and a session's box, which downloads the registry, runs agent code.
 */

/** Where the org reaches GitHub, or null for nowhere (a public repository
 *  is still read). */
async function sourceFor(userId: string, orgId: string): Promise<SourceAccess | null> {
  try {
    return await repositorySource(userId, orgId);
  } catch {
    return null;
  }
}

export async function GET(request: Request, context: RouteContext) {
  const c = await environmentRequest(request, context.params);
  if ("response" in c) return c.response;
  const listed = await listEnvironmentSkills(c.owner.id, c.params.id);
  if (!listed) return projectNotFound();
  const source = listed.registries.length > 0 ? await sourceFor(c.owner.id, listed.orgId) : null;
  const registries = await Promise.all(
    listed.registries.map(async (registry) => {
      const token = await source?.readToken(registry.fullName).catch(() => null);
      const skills = await registrySkills(token, registry.fullName, registry.defaultBranch);
      return {
        ...registry,
        skills: skills ?? [],
        error: skills ? null : `GitHub wouldn't list ${registry.fullName}: it may be gone, or out of the org's reach.`,
      };
    }),
  );
  return NextResponse.json({ registries });
}

export async function POST(request: Request, context: RouteContext) {
  const c = await environmentRequest(request, context.params, { write: true });
  if ("response" in c) return c.response;
  const { id } = c.params;
  const body = (await request.json().catch(() => null)) as { url?: unknown } | null;
  const listed = await listEnvironmentSkills(c.owner.id, id);
  if (!listed) return projectNotFound();
  // Refused before GitHub is asked anything.
  if (!allows(listed.access, "write")) return NextResponse.json({ error: new EnvironmentAccessError().message }, { status: 403 });
  let fullName: string;
  try {
    fullName = registryRepo(body?.url);
  } catch (error) {
    if (error instanceof EnvironmentRuleError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
  const source = await sourceFor(c.owner.id, listed.orgId);
  let found: { fullName: string; defaultBranch: string; private: boolean } | null;
  try {
    found = (await source?.lookup(fullName)) ?? (await publicRepository(fullName));
  } catch (error) {
    return githubErrorResponse(error, "Couldn't look that repository up on GitHub.");
  }
  if (!found) {
    return NextResponse.json(
      { error: `${fullName} isn't on GitHub, or the org can't read it. For a private one, add it to the org's GitHub App.` },
      { status: 400 },
    );
  }
  const repo = { fullName: found.fullName, defaultBranch: found.defaultBranch, private: found.private };
  // Refused now rather than failing at every session's start.
  const token = repo.private ? await source?.readToken(repo.fullName).catch(() => null) : null;
  if (repo.private && !token) {
    return NextResponse.json(
      {
        error: `${repo.fullName} is private: Outrunner reads a private registry only through the org's GitHub App. Install it on ${repo.fullName.split("/")[0]} with access to this repository, or use a public one.`,
      },
      { status: 400 },
    );
  }

  return savingSettings("project skill registries", async () => {
    try {
      const registry = await addSkillRegistry(c.owner.id, id, repo);
      const skills = await registrySkills(token, registry.fullName, registry.defaultBranch);
      // Ready boxes were made without its skills: made again.
      after(() => refillAfterChange(c.owner.id, id), { where: "refill-pool", userId: c.owner.id });
      return NextResponse.json({ registry, skills: skills ?? [] }, { status: 201 });
    } catch (error) {
      if (error instanceof EnvironmentRuleError) return NextResponse.json({ error: error.message }, { status: 400 });
      if (error instanceof SkillConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
      if (error instanceof EnvironmentAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
  });
}
