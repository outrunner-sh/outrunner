import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { githubErrorResponse } from "@/lib/github/http";
import { requireGithubToken } from "@/lib/github/token";

/**
 * The signed-in user's GitHub token, for the Mac app to clone a repository
 * they picked for a local session (NEE-55): only the page can hand it to the
 * app, and the app uses it for that clone only, never writing it down. It is
 * the user's own token, returned to their own page, as `outrunnerModelKey` is.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  try {
    return NextResponse.json(
      { token: await requireGithubToken(owner.id) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return githubErrorResponse(error, "Couldn't reach GitHub for that repository.");
  }
}
