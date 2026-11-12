/**
 * An org stops using a Linear workspace (Settings → Org → Integrations → Linear).
 * Its teams and rules go with it, and items already filed stay. Another org that
 * uses the workspace keeps it; with none left, nothing keeps the token fresh or
 * uses it, so it's dropped and handed back to Linear.
 */

export type DisconnectDeps = {
  /** Remove the org's link; whether it had one. */
  removeOrg(orgId: string, installationId: string): Promise<boolean>;
  orgIds(installationId: string): Promise<string[]>;
  load(installationId: string): Promise<{ accessToken: string | null } | null>;
  markDisconnected(installationId: string): Promise<void>;
  revoke(token: string): Promise<void>;
  audit(): Promise<unknown>;
};

/** False for an install the org doesn't use: nothing is touched or recorded, as
 *  one org's admin can't act on another's by naming its id. */
export async function disconnectOrgFromWorkspace(orgId: string, installationId: string, deps: DisconnectDeps): Promise<boolean> {
  if (!(await deps.removeOrg(orgId, installationId))) return false;
  if ((await deps.orgIds(installationId)).length === 0) {
    const row = await deps.load(installationId);
    await deps.markDisconnected(installationId);
    if (row?.accessToken) await deps.revoke(row.accessToken);
  }
  await deps.audit();
  return true;
}
