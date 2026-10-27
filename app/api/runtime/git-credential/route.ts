import { NextResponse } from "next/server";

import { projectLevel, listOrgProjects } from "@/lib/db/org-access";
import { memberRole } from "@/lib/db/orgs";
import { MissingGithubTokenError } from "@/lib/github/client";
import { GitIdentityError } from "@/lib/github/identity";
import { gitCredentialFor } from "@/lib/github/identity.deps";
import { isGitHubFullName } from "@/lib/github/listing";
import { gitCredentialRequestValid } from "@/lib/runtime/git-credential";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A request's body is a repository's name at most. */
const MAX_BODY_BYTES = 4096;

/**
 * A GitHub token for a box's git and `gh`, asked by its agent as they need
 * one (runtime-agent/internal/gitcred): the App's last an hour, so a box
 * can't be handed one when it starts and keep it.
 *
 * The agent signs with its box's secret (lib/runtime/git-credential.ts). The
 * token is for its user as they chose (lib/github/identity.ts), for the
 * repository asked (`{ repo: "owner/name" }`), or the box's own project's
 * with none:
 *
 * - their own GitHub sign-in, whatever the repository, as the box had before;
 * - the App's, for a project of the box's org at the member's level on it
 *   (read access reads), or read-only for a repository of the App's that
 *   isn't a project.
 */
export async function POST(request: Request) {
  const sandboxId = request.headers.get("x-outrunner-sandbox");
  const body = await request.text();
  if (!sandboxId || body.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Not a box's request." }, { status: 400 });
  }

  const { data: computers, error } = await createSupabaseAdminClient()
    .from("runtime_computers")
    .select("id, owner_id, org_id, project_id, agent_secret")
    .eq("daytona_sandbox_id", sandboxId)
    .limit(5);
  if (error) {
    console.error("Git credential: couldn't read the box", error);
    return NextResponse.json({ error: "Outrunner couldn't look up this box. Try again." }, { status: 503 });
  }
  const signed = {
    sandboxId,
    timestamp: request.headers.get("x-outrunner-timestamp"),
    signature: request.headers.get("x-outrunner-signature"),
    body,
  };
  const computer = (computers ?? []).find((c) => c.agent_secret && gitCredentialRequestValid(c.agent_secret, signed));
  if (!computer) return NextResponse.json({ error: "Bad signature." }, { status: 401 });

  let asked: unknown;
  try {
    asked = body ? (JSON.parse(body) as { repo?: unknown }).repo : undefined;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (asked !== undefined && asked !== "" && (typeof asked !== "string" || !isGitHubFullName(asked))) {
    return NextResponse.json({ error: "Name a GitHub repository as owner/name." }, { status: 400 });
  }

  try {
    // Still theirs to work in: a member removed since is refused.
    if (!(await memberRole(computer.org_id, computer.owner_id))) {
      return NextResponse.json({ error: "You're no longer a member of this org." }, { status: 403 });
    }
    const projects = await listOrgProjects(computer.org_id);
    const repo = typeof asked === "string" && asked ? asked : projects.find((p) => p.id === computer.project_id)?.fullName;
    if (!repo) return NextResponse.json({ error: "This box's project is gone." }, { status: 404 });
    const project = projects.find((p) => p.fullName.toLowerCase() === repo.toLowerCase());
    const level = project ? await projectLevel(computer.owner_id, project.id) : "read";
    if (!level) {
      return NextResponse.json({ error: `You no longer have access to ${repo} in this org.` }, { status: 403 });
    }

    const credential = await gitCredentialFor({ userId: computer.owner_id, orgId: computer.org_id, repo, level });
    return NextResponse.json(
      { token: credential.token, expiresAt: credential.expiresAt?.toISOString() ?? null, identity: credential.identity },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (cause) {
    if (cause instanceof GitIdentityError) {
      return NextResponse.json({ error: cause.message, reason: cause.reason }, { status: 409 });
    }
    if (cause instanceof MissingGithubTokenError) {
      return NextResponse.json({ error: cause.message, reason: "reconnect" }, { status: 409 });
    }
    console.error(`Git credential: no token for box ${sandboxId}`, cause);
    return NextResponse.json({ error: "Outrunner couldn't get a GitHub token. Try again." }, { status: 502 });
  }
}
