import { revoked, type CodexStore } from "@/lib/codex/account";
import type { CodexGrant } from "@/lib/codex/grant";
export type AccessDeps = {
  store: Pick<CodexStore, "read">;
  memberRole(org: string, user: string): Promise<unknown>;
};

export async function checkCodexGrant(grant: CodexGrant, deps: AccessDeps) {
  const row = await deps.store.read(grant.key);
  if (
    !row ||
    row.generation !== grant.generation ||
    row.status === "disconnected"
  )
    throw revoked();
  if (
    grant.key !== `personal:${grant.user}` &&
    grant.key !== `org:${grant.org}`
  )
    throw revoked();
  if (grant.org && !(await deps.memberRole(grant.org, grant.user)))
    throw revoked();
  if (!grant.org && grant.key !== `personal:${grant.user}`) throw revoked();
  return row;
}
export async function selectCodexAccount(
  user: string,
  org: string | undefined,
  personalKey: boolean,
  explicit: boolean,
  deps: AccessDeps,
) {
  const own = await deps.store.read(`personal:${user}`);
  if (own && own.status !== "disconnected") return own;
  if (!org || (personalKey && !explicit)) return null;
  const shared = await deps.store.read(`org:${org}`);
  if (!(await deps.memberRole(org, user))) return null;
  return shared && shared.status !== "disconnected" ? shared : null;
}
