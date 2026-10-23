import { NextResponse } from "next/server";

import { getCliOwner } from "@/lib/auth/cli-owner";
import { getOwner } from "@/lib/auth/owner";
import { ownerOfRequest } from "@/lib/auth/request-owner";
import { githubErrorResponse } from "@/lib/github/http";
import { requireGithubToken } from "@/lib/github/token";
import { ImportError } from "@/lib/imports/commit";
import { importProvider, planDeps } from "@/lib/imports/deps";
import { planImports } from "@/lib/imports/plan";
import { ImportPlanRequest } from "@/lib/runtime/import-scan";

/**
 * Plan an import of sessions the desktop app or the CLI found on the user's
 * computer: each gets a new workspace id and signed upload URLs for its
 * artifacts, or the reason it can't come (a repository their GitHub can't
 * see, a session imported already). A taken branch is imported under a free
 * one instead.
 */
export async function POST(request: Request) {
  const signedIn = await ownerOfRequest(request, { cli: getCliOwner, browser: getOwner });
  if ("response" in signedIn) return signedIn.response;
  const { owner } = signedIn;
  const parsed = ImportPlanRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Pick the sessions to import from a scan." }, { status: 400 });
  }

  try {
    // Before anything is minted: the sessions will need a cloud computer.
    await importProvider(owner.id);
    const token = await requireGithubToken(owner.id);
    const items = await planImports(owner.id, parsed.data, planDeps(owner.id, token));
    return NextResponse.json({ items });
  } catch (error) {
    if (error instanceof ImportError) {
      return NextResponse.json({ error: error.message, settingsHref: "/settings/sandbox" }, { status: error.status });
    }
    return githubErrorResponse(error, "Could not plan the import. Please try again.");
  }
}
