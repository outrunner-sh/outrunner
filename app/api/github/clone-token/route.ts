import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { MissingGithubTokenError } from "@/lib/github/client";
import { githubErrorResponse } from "@/lib/github/http";
import { GitIdentityError } from "@/lib/github/identity";
import { gitCredentialFor } from "@/lib/github/identity.deps";
import { isGitHubFullName } from "@/lib/github/listing";
import { personalCredential } from "@/lib/github/personal";
import { activeOrgId } from "@/lib/orgs/server";

/**
 * A GitHub token for the Mac app to clone a repository they picked for a
 * local session (NEE-55): only the page can hand it to the app, and the app
 * uses it for that clone only, never writing it down. Returned to their own
 * page, as `outrunnerModelKey` is.
 *
 * The narrowest token that clones `{ fullName }`: a read-only one of the
 * org's Outrunner App for that repository alone, an hour long, for a project
 * they have access to in the org they're looking at; else their own: a
 * personal access token they pasted, or their GitHub App user token (8 hours
 * at most). An old sign-in token, which never expires
 * and reaches everything they can, only while those are still allowed
 * (GITHUB_LEGACY_TOKENS) and they have nothing narrower.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { fullName?: unknown } | null;
  const fullName = typeof body?.fullName === "string" && isGitHubFullName(body.fullName) ? body.fullName : null;
  if (!fullName) return NextResponse.json({ error: "Name a GitHub repository as owner/name." }, { status: 400 });
  try {
    const orgId = await activeOrgId();
    if (orgId) {
      try {
        const app = await gitCredentialFor({ userId: owner.id, orgId, repo: fullName, identity: "app", level: "read" });
        return reply(app.token);
      } catch (error) {
        // Not one of the org's App's: their own, below.
        if (!(error instanceof GitIdentityError)) throw error;
      }
    }
    const own = await personalCredential(owner.id);
    if (!own) throw new MissingGithubTokenError();
    return reply(own.token);
  } catch (error) {
    return githubErrorResponse(error, "Couldn't reach GitHub for that repository.");
  }
}

function reply(token: string) {
  return NextResponse.json({ token }, { headers: { "cache-control": "no-store" } });
}
