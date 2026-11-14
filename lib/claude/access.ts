export type ClaudeRef = {
  kind: "personal" | "org";
  id: string;
  revision: string;
};
export type ClaudeGrant = {
  purpose: "claude-inference";
  user: string;
  org: string;
  primary: ClaudeRef;
  fallback?: ClaudeRef;
};
export class ClaudeAccessError extends Error {
  constructor() {
    super(
      "This Claude connection is no longer available. Check Settings → Coding agents.",
    );
  }
}
export type ClaudeAccessDeps = {
  member(org: string, user: string): Promise<unknown>;
  read(ref: ClaudeRef): Promise<{ revision: string; token: string } | null>;
};
/** Bind every request to the original connection, including when using its
 * fallback. Reconnecting or disconnecting either credential revokes its grants. */
export async function authorizeClaude(
  grant: ClaudeGrant,
  ref: ClaudeRef,
  deps: ClaudeAccessDeps,
): Promise<string> {
  const valid = (r: ClaudeRef) =>
    r.kind === "personal" ? r.id === grant.user : r.id === grant.org;
  const same = (a: ClaudeRef, b: ClaudeRef) =>
    a.kind === b.kind && a.id === b.id && a.revision === b.revision;
  if (
    !valid(grant.primary) ||
    !valid(ref) ||
    (!same(ref, grant.primary) &&
      (!grant.fallback || !same(ref, grant.fallback))) ||
    (grant.fallback &&
      (grant.primary.kind !== "personal" ||
        grant.fallback.kind !== "org" ||
        !valid(grant.fallback)))
  )
    throw new ClaudeAccessError();
  if (!(await deps.member(grant.org, grant.user)))
    throw new ClaudeAccessError();
  const primary = await deps.read(grant.primary);
  if (!primary || primary.revision !== grant.primary.revision)
    throw new ClaudeAccessError();
  const current = same(ref, grant.primary) ? primary : await deps.read(ref);
  if (!current || current.revision !== ref.revision)
    throw new ClaudeAccessError();
  if (!(await deps.member(grant.org, grant.user)))
    throw new ClaudeAccessError();
  return current.token;
}
