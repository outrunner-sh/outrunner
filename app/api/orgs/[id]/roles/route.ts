import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { createRole } from "@/lib/db/org-access";
import { roleName } from "@/lib/orgs/access";
import { changingAccess } from "@/lib/orgs/access-routes";
import { orgCaller } from "@/lib/orgs/routes";

/** Make a role, `{ name }`: the org's admins may. It grants nothing until a
 *  grant gives it something. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const name = roleName(body?.name);
  if (!name) return NextResponse.json({ error: "Give the role a name, up to 80 characters." }, { status: 400 });
  return changingAccess("the org's roles", async () => {
    const role = await createRole(id, name);
    await recordAudit({ orgId: id, actor: caller.owner, action: "role.created", resource: { type: "role", id: role.id, label: name } });
    return NextResponse.json({ role }, { status: 201 });
  });
}

