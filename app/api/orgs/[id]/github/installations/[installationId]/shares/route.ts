import { NextResponse } from "next/server";

import { listInstallationShares } from "@/lib/db/github-installations";
import { orgCaller } from "@/lib/orgs/routes";

/**
 * The other Outrunner orgs this org's installation is shared with: for the
 * admins of its source org (the first org it was connected to) alone, so the org that
 * brought it can see where else its repositories are reached from, and take
 * that away (./[orgId]).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; installationId: string }> }) {
  const { id, installationId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const installation = Number(installationId);
  if (!Number.isSafeInteger(installation) || installation <= 0) {
    return NextResponse.json({ error: "No such installation." }, { status: 404 });
  }
  try {
    const shares = await listInstallationShares(id, installation);
    if (!shares) {
      return NextResponse.json({ error: "Only the org that first connected this installation sees where it's shared." }, { status: 403 });
    }
    return NextResponse.json({ shares });
  } catch (error) {
    console.error(`Could not list installation ${installation}'s shares`, error);
    return NextResponse.json({ error: "Couldn't do that. Try again." }, { status: 500 });
  }
}
