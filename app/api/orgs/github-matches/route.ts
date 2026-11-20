import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { userAuthConfigured } from "@/lib/github/user-connection.deps";
import { githubErrorResponse } from "@/lib/github/http";
import { isSameOriginRead } from "@/lib/http/guards";
import { signInFirst } from "@/lib/http/settings-save";
import { githubJoinMatches } from "@/lib/orgs/github-join";
import { githubJoinDeps } from "@/lib/orgs/github-join.deps";

/**
 * The team orgs the signed-in user could join through their GitHub
 * organizations (lib/orgs/github-join.ts): `{ matches, githubConnected,
 * canConnect }`. Asks GitHub, once per installation worth asking, so only
 * "New organization" calls it, as it opens; never a page load.
 *
 * `githubConnected: false`: no GitHub connection to look with, and
 * `canConnect` says whether this deployment can make one.
 */
export async function GET(request: Request) {
  if (!isSameOriginRead(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  try {
    const found = await githubJoinMatches(owner.id, githubJoinDeps);
    return NextResponse.json(
      { ...found, canConnect: userAuthConfigured() },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return githubErrorResponse(error, "Couldn't look for your GitHub organizations' orgs. Try again.");
  }
}
