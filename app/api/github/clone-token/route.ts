import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { githubErrorResponse } from "@/lib/github/http";
import { gitCredentialFor } from "@/lib/github/identity.deps";
import { isGitHubFullName } from "@/lib/github/listing";
import { requireGithubToken } from "@/lib/github/token";
import { activeOrgId } from "@/lib/orgs/server";

/**
 * A GitHub token for the Mac app to clone a repository they picked for a
 * local session (NEE-55): only the page can hand it to the app, and the app
 * uses it for that clone only, never writing it down. Returned to their own
 * page, as `outrunnerModelKey` is.
 *
 * As the user chose to work on GitHub (lib/github/identity.ts): their own
 * token, or, for `{ fullName }` in the org they're looking at, a read-only one
 * of the org's Outrunner App for that repository. A page from before
 * `fullName` gets their own.
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
  try {
    const orgId = fullName ? await activeOrgId() : undefined;
    const token =
      fullName && orgId
        ? (await gitCredentialFor({ userId: owner.id, orgId, repo: fullName, level: "read" })).token
        : await requireGithubToken(owner.id);
    return NextResponse.json({ token }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return githubErrorResponse(error, "Couldn't reach GitHub for that repository.");
  }
}
