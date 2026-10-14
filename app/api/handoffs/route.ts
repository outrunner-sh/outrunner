import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getProjectByFullName, upsertProjects } from "@/lib/db/repositories";
import { getGitHubRepository, GitHubSyncError } from "@/lib/github/client";
import { optionalGithubToken } from "@/lib/github/token";
import { isSameOriginRequest } from "@/lib/http/guards";
import { mintHandoffUploads } from "@/lib/runtime/handoff/storage";
import { supabaseHandoffStorage } from "@/lib/runtime/storage/supabase-adapter";

export const dynamic = "force-dynamic";

/** `owner/name`, as GitHub spells them. */
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * Start continuing a session from this Mac in the cloud: the project the cloud
 * session goes in, and upload URLs for the package the Mac's agent makes of it.
 * The session's repository becomes a project here if it isn't one yet, as long
 * as the user's GitHub reaches it: continuing it is asking for that.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { repo?: unknown } | null;
  const repo = typeof body?.repo === "string" ? body.repo : "";
  if (!REPO.test(repo)) {
    return NextResponse.json({ error: "Only a session on a GitHub repository can continue in the cloud." }, { status: 400 });
  }

  let project = await getProjectByFullName(repo);
  if (!project) {
    const token = await optionalGithubToken(owner.id);
    try {
      const found = token ? await getGitHubRepository(token, repo) : null;
      if (found) {
        await upsertProjects(owner.id, [found]);
        project = await getProjectByFullName(found.fullName);
      }
    } catch (error) {
      if (!(error instanceof GitHubSyncError)) throw error;
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
  }
  if (!project) {
    return NextResponse.json(
      { error: `Your GitHub account can't reach ${repo}, so the cloud can't clone it.` },
      { status: 404 },
    );
  }

  const handoffId = randomUUID();
  const uploads = await mintHandoffUploads(supabaseHandoffStorage(), owner.id, handoffId);
  return NextResponse.json({ handoffId, projectId: project.id, uploads });
}
