import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { deleteRole, listRoles, renameRole } from "@/lib/db/org-access";
import { isUuid } from "@/lib/ids";
import { roleName } from "@/lib/orgs/access";
import { changingAccess } from "@/lib/orgs/access-routes";
import { orgCaller } from "@/lib/orgs/routes";

type Params = { params: Promise<{ id: string; roleId: string }> };

/** Rename a role, `{ name }`. The org's admins may. */
export async function PATCH(request: Request, { params }: Params) {
  const { id, roleId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if (!isUuid(roleId)) return NextResponse.json({ error: "No such role." }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const name = roleName(body?.name);
  if (!name) return NextResponse.json({ error: "Give the role a name, up to 80 characters." }, { status: 400 });
  return changingAccess("a role", async () => {
    const before = await roleNameOf(id, roleId);
    if (!(await renameRole(id, roleId, name))) return NextResponse.json({ error: "No such role." }, { status: 404 });
    await recordAudit({
      orgId: id,
      actor: caller.owner,
      action: "role.renamed",
      resource: { type: "role", id: roleId, label: name },
      details: { from: before },
    });
    return NextResponse.json({ role: { id: roleId, name } });
  });
}

/** Delete a role: its grants go, and its members keep only what Everyone and
 *  their other roles give them. The org's admins may. */
export async function DELETE(request: Request, { params }: Params) {
  const { id, roleId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if (!isUuid(roleId)) return NextResponse.json({ error: "No such role." }, { status: 404 });
  return changingAccess("a role", async () => {
    const before = await roleNameOf(id, roleId);
    if (!(await deleteRole(id, roleId))) return NextResponse.json({ error: "No such role." }, { status: 404 });
    await recordAudit({ orgId: id, actor: caller.owner, action: "role.deleted", resource: { type: "role", id: roleId, label: before } });
    return NextResponse.json({ deleted: roleId });
  });
}

/** A role's name as it is now, for the audit log; null for none. */
async function roleNameOf(orgId: string, roleId: string): Promise<string | null> {
  return (await listRoles(orgId).catch(() => [])).find((r) => r.id === roleId)?.name ?? null;
}
