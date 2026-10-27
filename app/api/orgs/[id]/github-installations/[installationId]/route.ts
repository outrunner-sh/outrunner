import { NextResponse } from "next/server";

import { unlinkInstallation } from "@/lib/db/github-installations";
import { installationId } from "@/lib/github/installation";
import { databaseNotUpdated } from "@/lib/http/database-not-updated";
import { orgCaller } from "@/lib/orgs/routes";

/**
 * Unlink a GitHub App installation from an org: its admins may. Code review
 * stops posting on its repositories for this org; the app stays installed on
 * GitHub, where it's uninstalled.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; installationId: string }> },
) {
  const { id, installationId: rawId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const installation = installationId(rawId);
  if (installation === null) return NextResponse.json({ error: "No such installation." }, { status: 404 });
  try {
    const removed = await unlinkInstallation(id, installation);
    if (!removed) return NextResponse.json({ error: "No such installation." }, { status: 404 });
    return NextResponse.json({ unlinked: true });
  } catch (error) {
    const notUpdated = databaseNotUpdated(error, "the GitHub App installation");
    if (notUpdated) return notUpdated;
    console.error("Could not unlink a GitHub App installation", error);
    return NextResponse.json({ error: "Couldn't unlink it. Try again." }, { status: 500 });
  }
}
