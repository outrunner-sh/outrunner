import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { getOwner } from "@/lib/auth/owner";
import { getOrg, renameOrg } from "@/lib/db/orgs";
import { isUuid } from "@/lib/ids";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";
import { orgName } from "@/lib/orgs/active";

/** Rename an org, `{ name }`: its admins may. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "No such org." }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const name = orgName(body?.name);
  if (!name) return NextResponse.json({ error: "Give the org a name, up to 80 characters." }, { status: 400 });

  return savingSettings("the org's name", async () => {
    // Only for the log: never what fails the rename.
    const before = await getOrg(id).catch(() => null);
    if (!(await renameOrg(id, owner.id, name))) {
      return NextResponse.json({ error: "Only the org's admins can rename it." }, { status: 403 });
    }
    await recordAudit({
      orgId: id,
      actor: owner,
      action: "org.renamed",
      resource: { type: "org", id, label: name },
      details: { from: before?.name ?? null, to: name },
    });
    return NextResponse.json({ org: { id, name } });
  });
}
