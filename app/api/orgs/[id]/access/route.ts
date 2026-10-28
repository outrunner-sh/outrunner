import { NextResponse } from "next/server";

import { listGrants, listOrgProjects, listRoles } from "@/lib/db/org-access";
import { listMembers } from "@/lib/db/org-members";
import { orgCaller } from "@/lib/orgs/routes";

/**
 * Everything an org's Roles & access page shows (its admins only): its roles
 * and who holds each, its grants, its projects, and its members with their
 * roles (20261028145000_org_access.sql).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const [roles, grants, projects, members] = await Promise.all([
    listRoles(id),
    listGrants(id),
    listOrgProjects(id),
    listMembers(id),
  ]);
  return NextResponse.json({
    roles,
    grants,
    projects,
    members: members.map((m) => ({
      userId: m.userId,
      name: m.name,
      login: m.login,
      role: m.role,
      roleIds: roles.filter((r) => r.memberIds.includes(m.userId)).map((r) => r.id),
    })),
  });
}
