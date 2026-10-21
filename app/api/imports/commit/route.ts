import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { commitImport, ImportError } from "@/lib/imports/commit";
import { commitDeps } from "@/lib/imports/deps";
import { ImportCommitRequest } from "@/lib/runtime/import-scan";

/**
 * Finish importing one session whose artifacts the desktop app uploaded where
 * the plan said: it becomes an archived workspace, resumed in the cloud by
 * Restore.
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

  try {
    const { workspaceId } = await commitImport(owner.id, parsed.data, commitDeps(owner.id));
    return NextResponse.json({ workspace: { id: workspaceId, status: "archived" } });
  } catch (error) {
    if (error instanceof ImportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(`Import of ${parsed.data.key} failed`, error);
    return NextResponse.json({ error: "Could not finish the import. Please try again." }, { status: 502 });
  }
}
