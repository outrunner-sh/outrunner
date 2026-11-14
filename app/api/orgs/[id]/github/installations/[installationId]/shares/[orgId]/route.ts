import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { listInstallationShares, listOrgInstallations, removeInstallationShare } from "@/lib/db/github-installations";
import { orgCaller } from "@/lib/orgs/routes";

type Params = { params: Promise<{ id: string; installationId: string; orgId: string }> };

/** Stop sharing this org's installation with another org: its source org's
 *  admins only. That org's link goes; this org's and the installation stay. */
export async function DELETE(request: Request, { params }: Params) {
  const { id, installationId, orgId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const installation = Number(installationId);
  if (!Number.isSafeInteger(installation) || installation <= 0) {
    return NextResponse.json({ error: "No such installation." }, { status: 404 });
  }
  try {
    const [shares, own] = await Promise.all([
      listInstallationShares(id, installation).catch(() => null),
      listOrgInstallations(id).catch(() => []),
    ]);
    const refused = await removeInstallationShare(id, installation, orgId);
    if (refused === "not_source") {
      return NextResponse.json({ error: "Only the org that first connected this installation can stop sharing it." }, { status: 403 });
    }
    if (refused === "not_shared") return NextResponse.json({ error: "It isn't shared with that org." }, { status: 404 });
    const share = shares?.find((s) => s.orgId === orgId);
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "github.share_removed",
      resource: { type: "installation", id: String(installation), label: own.find((i) => i.id === installation)?.accountLogin ?? null },
      details: { orgId, orgName: share?.orgName ?? null, linkedBy: share?.linkedByEmail ?? null },
    });
    return NextResponse.json({ removed: orgId });
  } catch (error) {
    console.error(`Could not stop sharing installation ${installation} with ${orgId}`, error);
    return NextResponse.json({ error: "Couldn't do that. Try again." }, { status: 500 });
  }
}
