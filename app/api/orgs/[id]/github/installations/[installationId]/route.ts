import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { listOrgInstallations, unclaimInstallation } from "@/lib/db/github-installations";
import { orgCaller } from "@/lib/orgs/routes";

/** Disconnect only this org; other orgs and the GitHub installation keep access. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; installationId: string }> }) {
  const { id, installationId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const installation = Number(installationId);
  if (!Number.isSafeInteger(installation) || installation <= 0) {
    return NextResponse.json({ error: "No such installation." }, { status: 404 });
  }
  try {
    const account = (await listOrgInstallations(id).catch(() => [])).find((i) => i.id === installation)?.accountLogin;
    if (!(await unclaimInstallation(installation, id))) {
      return NextResponse.json({ error: "No such installation." }, { status: 404 });
    }
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "github.removed",
      resource: { type: "installation", id: String(installation), label: account ?? null },
    });
    return NextResponse.json({ forgotten: installation });
  } catch (error) {
    console.error(`Could not let installation ${installation} go`, error);
    return NextResponse.json({ error: "Couldn't do that. Try again." }, { status: 500 });
  }
}
