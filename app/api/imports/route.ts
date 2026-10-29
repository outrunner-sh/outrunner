import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { githubErrorResponse } from "@/lib/github/http";
import { repositorySource } from "@/lib/github/repository-source";
import { isSameOriginRequest } from "@/lib/http/guards";
import { ImportError } from "@/lib/imports/commit";
import { importProvider, planDeps } from "@/lib/imports/deps";
import { planImports } from "@/lib/imports/plan";
import { ImportPlanRequest } from "@/lib/runtime/import-scan";
import { connectRefusal } from "@/lib/orgs/connect-access";
import { activeOrgId } from "@/lib/orgs/server";

/**
 * Plan an import of sessions the desktop app found on the user's Mac: each
 * gets a new workspace id and signed upload URLs for its artifacts, or the
 * reason it can't come (a repository their GitHub can't see, a session
 * imported already). A taken branch is imported under a free one instead.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const parsed = ImportPlanRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Pick the sessions to import from a scan." }, { status: 400 });
  }

  try {
    // Before anything is minted: the sessions will need a cloud computer.
    await importProvider(owner.id);
    const orgId = await activeOrgId();
    const refused = await connectRefusal(owner.id, orgId);
    if (refused) return refused;
    const { lookup } = await repositorySource(owner.id, orgId);
    const items = await planImports(owner.id, parsed.data, planDeps(owner.id, lookup, orgId));
    return NextResponse.json({ items });
  } catch (error) {
    if (error instanceof ImportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return githubErrorResponse(error, "Could not plan the import. Please try again.");
  }
}
