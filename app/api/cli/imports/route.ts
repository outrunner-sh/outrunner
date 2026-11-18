import { NextResponse } from "next/server";

import { getCliOwner } from "@/lib/auth/cli-owner";
import { asCliUser, cliSignInFirst, planImportResponse } from "@/lib/imports/routes";
import { ImportPlanRequest } from "@/lib/runtime/import-scan";
import { memberOrgId } from "@/lib/triage/caller";

/**
 * `outrunner import`: plan an import of sessions the CLI found on the user's
 * computer, as POST /api/imports does for the Mac app, signed in by the CLI's
 * token rather than the browser's cookie. Their projects go in the org
 * `?org=` names (an id or a name), else the user's personal one, as
 * `outrunner triage` files into.
 *
 * Only a session import: an environment or agent setup changes what runs on
 * the org's boxes, which a CLI token may not (lib/api/auth.ts boxSetupRefusal).
 * No Origin check: a browser never sends a bearer token on its own.
 */
export async function POST(request: Request) {
  const owner = await getCliOwner(request);
  if (!owner) return cliSignInFirst();
  const parsed = ImportPlanRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Pick the sessions to import from a scan." }, { status: 400 });
  }
  const wanted = new URL(request.url).searchParams.get("org");
  const orgId = await memberOrgId(owner.id, wanted);
  if (!orgId) {
    return NextResponse.json(
      { error: wanted ? `You aren't a member of an org named ${wanted}.` : "You aren't in an org yet." },
      { status: 404 },
    );
  }
  return asCliUser(owner.id, () => planImportResponse(owner.id, parsed.data, async () => orgId));
}
