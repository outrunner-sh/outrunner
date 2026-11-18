/**
 * The import routes' work once the caller is signed in, shared by the web
 * app's routes (the browser's cookie, app/api/imports) and the CLI's (its
 * token, app/api/cli/imports), so an import planned or finished from either
 * answers alike.
 */

import { NextResponse } from "next/server";

import { githubErrorResponse } from "@/lib/github/http";
import { repositorySource } from "@/lib/github/repository-source";
import { commitImport, ImportError } from "@/lib/imports/commit";
import { commitDeps, importProvider, planDeps } from "@/lib/imports/deps";
import { planImports } from "@/lib/imports/plan";
import { connectRefusal } from "@/lib/orgs/connect-access";
import type { ImportCommitRequest, ImportPlanRequest } from "@/lib/runtime/import-scan";

/**
 * Plan `request` for `ownerId`: each session gets a new workspace id and
 * signed upload URLs for its artifacts, or the reason it can't come. Its
 * projects go in the org `orgId` resolves to, asked only once the user is
 * known to have a cloud computer for the sessions.
 */
export async function planImportResponse(
  ownerId: string,
  request: ImportPlanRequest,
  orgId: () => Promise<string | undefined>,
): Promise<Response> {
  try {
    // Before anything is minted: the sessions will need a cloud computer.
    await importProvider(ownerId);
    const org = await orgId();
    const refused = await connectRefusal(ownerId, org);
    if (refused) return refused;
    const { lookup } = await repositorySource(ownerId, org);
    const items = await planImports(ownerId, request, planDeps(ownerId, lookup, org));
    return NextResponse.json({ items });
  } catch (error) {
    if (error instanceof ImportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return githubErrorResponse(error, "Could not plan the import. Please try again.");
  }
}

/**
 * Finish importing one session whose artifacts were uploaded where the plan
 * said: it becomes an archived workspace, resumed in the cloud by Restore.
 */
export async function commitImportResponse(ownerId: string, request: ImportCommitRequest): Promise<Response> {
  try {
    const { workspaceId } = await commitImport(ownerId, request, commitDeps(ownerId));
    return NextResponse.json({ workspace: { id: workspaceId, status: "archived" } });
  } catch (error) {
    if (error instanceof ImportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(`Import of ${request.key} failed`, error);
    return NextResponse.json({ error: "Could not finish the import. Please try again." }, { status: 502 });
  }
}
