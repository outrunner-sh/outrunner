import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { planImportResponse } from "@/lib/imports/routes";
import { ImportPlanRequest } from "@/lib/runtime/import-scan";
import { activeOrgId } from "@/lib/orgs/server";

/**
 * Plan an import of sessions the desktop app found on the user's Mac: each
 * gets a new workspace id and signed upload URLs for its artifacts, or the
 * reason it can't come (a repository their GitHub can't see, a session
 * imported already). A taken branch is imported under a free one instead.
 * The CLI's counterpart is app/api/cli/imports.
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
  // Into the active org, where the user is looking.
  return planImportResponse(owner.id, parsed.data, activeOrgId);
}
