import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { commitImportResponse } from "@/lib/imports/routes";
import { ImportCommitRequest } from "@/lib/runtime/import-scan";

/**
 * Finish importing one session whose artifacts the desktop app uploaded where
 * the plan said: it becomes an archived workspace, resumed in the cloud by
 * Restore. The CLI's counterpart is app/api/cli/imports/commit.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const parsed = ImportCommitRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "That isn't an import to finish." }, { status: 400 });
  }
  return commitImportResponse(owner.id, parsed.data);
}
