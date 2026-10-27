/**
 * What a member may do with an org's projects (20261028150000_org_access.sql):
 * read (see it, start sessions on it) or write (also change its settings and
 * hide it; on all projects, connect new ones). Grants go to Everyone or a
 * role, on all projects or one; a member gets the highest that reaches them,
 * and admins write everything. The database decides (project_level); this
 * is what the app shows and asks with.
 */

export type AccessLevel = "read" | "write";

/** Whether `level` is at least `needed`. None is below read. */
export function allows(level: AccessLevel | null | undefined, needed: AccessLevel): boolean {
  if (!level) return false;
  return needed === "read" || level === "write";
}

/** A level as posted: read, write, or null to take a grant away. */
export function postedLevel(value: unknown): AccessLevel | null | undefined {
  if (value === null || value === "none") return null;
  return value === "read" || value === "write" ? value : undefined;
}

/** A role's name, as an admin may give it: trimmed, 1 to 80 characters. */
export function roleName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= 80 ? name : null;
}

/** One who and what a grant is for: Everyone (role null) or a role, on all
 *  projects (project null) or one. */
export type Grant = { roleId: string | null; projectId: string | null; level: AccessLevel };

/** What `roleIds` together give on `projectId`, from `grants`: the level an
 *  admin reading the Roles page sees for a member. Mirrors project_level for
 *  a member who isn't an admin. */
export function levelFrom(grants: readonly Grant[], roleIds: readonly string[], projectId: string): AccessLevel | null {
  let best: AccessLevel | null = null;
  for (const g of grants) {
    if (g.roleId !== null && !roleIds.includes(g.roleId)) continue;
    if (g.projectId !== null && g.projectId !== projectId) continue;
    if (g.level === "write") return "write";
    best = "read";
  }
  return best;
}
