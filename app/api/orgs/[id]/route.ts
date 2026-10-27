import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { renameOrg } from "@/lib/db/orgs";
import { isUuid } from "@/lib/ids";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";
import { orgName } from "@/lib/orgs/active";

/** Rename a team org, `{ name }`: its admins may. A personal org keeps its name. */
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
    if (!(await renameOrg(id, owner.id, name))) {
      return NextResponse.json({ error: "Only a team org's admins can rename it." }, { status: 403 });
    }
    return NextResponse.json({ org: { id, name } });
  });
}
