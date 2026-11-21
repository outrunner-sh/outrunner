import { NextResponse } from "next/server";

import { getCliOwner } from "@/lib/auth/cli-owner";
import { asCliUser, cliSignInFirst, commitImportResponse } from "@/lib/imports/routes";
import { ImportCommitRequest } from "@/lib/runtime/import-scan";

/**
 * `outrunner import`: finish importing one session whose artifacts the CLI
 * uploaded where POST /api/cli/imports said, as POST /api/imports/commit does
 * for the Mac app, signed in by the CLI's token. It becomes an archived
 * workspace, resumed in the cloud by Restore. The plan already chose its
 * project, in the org the CLI asked for.
 */
export async function POST(request: Request) {
  const owner = await getCliOwner(request);
  if (!owner) return cliSignInFirst();
  const parsed = ImportCommitRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "That isn't an import to finish." }, { status: 400 });
  }
  return asCliUser(owner.id, () => commitImportResponse(owner.id, parsed.data));
}
