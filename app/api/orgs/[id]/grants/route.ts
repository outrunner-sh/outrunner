import { NextResponse } from "next/server";

import { setGrant } from "@/lib/db/org-access";
import { isUuid } from "@/lib/ids";
import { postedLevel } from "@/lib/orgs/access";
import { changingAccess } from "@/lib/orgs/access-routes";
import { orgCaller } from "@/lib/orgs/routes";

/**
 * Set what Everyone (`roleId` null) or a role gets on all the org's projects
 * (`projectId` null) or one: `level` "read" or "write", or null for nothing.
 * The org's admins may; admins themselves always have write.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const body = (await request.json().catch(() => null)) as {
    roleId?: unknown;
    projectId?: unknown;
    level?: unknown;
  } | null;
  const roleId = idOrNull(body?.roleId);
  const projectId = idOrNull(body?.projectId);
  const level = postedLevel(body?.level);
  if (roleId === undefined || projectId === undefined || level === undefined) {
    return NextResponse.json({ error: "Choose who, which projects, and read, write or none." }, { status: 400 });
  }
  return changingAccess("the org's access", async () => {
    await setGrant(id, { roleId, projectId, level });
    return NextResponse.json({ grant: { roleId, projectId, level } });
  });
}

/** An id as posted, null for none (Everyone, all projects); undefined for
 *  anything else. */
function idOrNull(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && isUuid(value) ? value : undefined;
}
