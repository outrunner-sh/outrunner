/**
 * Who a public API call acts as, and in which org, from the credential it
 * carries (lib/api/keys.ts). No database here: lib/api/auth.deps.ts reads.
 *
 *   org key        its maker, in its org, while they're still one of the
 *                  org's admins (an admin manages the org's keys, and a key
 *                  outliving its maker's say over the org would be no one's)
 *   personal key   its maker, in the org `org` names (an id or a name),
 *   or CLI token   else their personal org, as `outrunner triage` does
 *
 * Either way the call has its maker's Roles & access in that org, no more:
 * every read and write runs as them (lib/api/handler.ts).
 */

import { apiError } from "@/lib/api/errors";
import type { ApiCredential } from "@/lib/api/keys";
import { hashApiKey, keyUsable } from "@/lib/api/keys";
import type { StoredApiKey } from "@/lib/db/api-keys";
import type { OrgRole } from "@/lib/orgs/active";

export type ApiCallerKind = "org_key" | "personal_key" | "cli_token";

export type ApiCaller = {
  kind: ApiCallerKind;
  userId: string;
  orgId: string;
  /** Their role in the org: an admin sees the org's sessions, not only theirs. */
  role: OrgRole;
  /** The key it carried, or the CLI token's id: exactly one is set. */
  keyId: string | null;
  cliTokenId: string | null;
};

export type ApiAuthDeps = {
  findKey(hash: string): Promise<StoredApiKey | null>;
  findCliToken(hash: string): Promise<{ id: string; userId: string } | null>;
  /** The user's org that `wanted` names (an id or a name), else their
   *  personal org; null when they're in none such. */
  memberOrgId(userId: string, wanted: string | null): Promise<string | null>;
  memberRole(orgId: string, userId: string): Promise<OrgRole | null>;
  /** Whether the user may still use Outrunner at all (the allowlist). */
  allowed(userId: string): Promise<boolean>;
  now?: () => number;
};

export type ApiAuth = { ok: true; caller: ApiCaller } | { ok: false; status: 401 | 403 | 404; message: string };

/** Sign a call in with `credential`, in the org `wanted` names (if any). */
export async function authorize(
  credential: ApiCredential | null,
  wanted: string | null,
  deps: ApiAuthDeps,
): Promise<ApiAuth> {
  if (!credential) {
    return refuse(401, "Send an API key as `Authorization: Bearer or_key_…`. Make one under Settings → API keys.");
  }
  const hash = hashApiKey(credential.secret);
  if (credential.kind === "cli_token") {
    const token = await deps.findCliToken(hash);
    if (!token) return refuse(401, "That CLI token was signed out. Run `outrunner login` again.");
    return inOrg(deps, { kind: "cli_token", userId: token.userId, keyId: null, cliTokenId: token.id }, wanted);
  }

  const key = await deps.findKey(hash);
  if (!key) return refuse(401, "That API key isn't one Outrunner knows.");
  if (!keyUsable(key, (deps.now ?? Date.now)())) {
    return refuse(401, key.revokedAt ? "That API key was revoked." : "That API key has expired.");
  }
  if (key.orgId === null) {
    return inOrg(deps, { kind: "personal_key", userId: key.userId, keyId: key.id, cliTokenId: null }, wanted);
  }

  // An org key is its org's alone: naming another is a mistake to say, not
  // to quietly ignore.
  if (wanted) {
    const named = await deps.memberOrgId(key.userId, wanted);
    if (named !== key.orgId) return refuse(403, "This API key is for another org. Leave `org` out, or use a key of that org's.");
  }
  const role = await deps.memberRole(key.orgId, key.userId);
  if (role !== "admin") {
    return refuse(401, "Whoever made this API key is no longer an admin of its org, so it doesn't work any more. Make a new one.");
  }
  if (!(await deps.allowed(key.userId))) return refuse(401, "Whoever made this API key can't use Outrunner any more.");
  return { ok: true, caller: { kind: "org_key", userId: key.userId, orgId: key.orgId, role, keyId: key.id, cliTokenId: null } };
}

async function inOrg(
  deps: ApiAuthDeps,
  who: Omit<ApiCaller, "orgId" | "role">,
  wanted: string | null,
): Promise<ApiAuth> {
  if (!(await deps.allowed(who.userId))) return refuse(401, "That account can't use Outrunner any more.");
  const orgId = await deps.memberOrgId(who.userId, wanted);
  if (!orgId) return refuse(404, wanted ? `You aren't a member of an org named ${wanted}.` : "You aren't in an org yet.");
  const role = await deps.memberRole(orgId, who.userId);
  if (!role) return refuse(404, "You aren't a member of that org.");
  return { ok: true, caller: { ...who, orgId, role } };
}

function refuse(status: 401 | 403 | 404, message: string): ApiAuth {
  return { ok: false, status, message };
}

/**
 * Why a credential may not change what runs on the org's boxes (a project's
 * setup scripts and hooks, instructions, variables and files, repositories,
 * MCP servers and skills), or null when it may. Those run in every member's session, beside their own GitHub
 * token, so only an org key may: an admin made it for the org, to manage it.
 * A personal key or the CLI's token, leaked from one member's machine, can't.
 * Keys have no scopes yet (20261102120000_api_keys.sql); until they do, this
 * is the line.
 */
export function boxSetupRefusal(kind: ApiCallerKind): string | null {
  if (kind === "org_key") return null;
  return "Changing what runs on the project's boxes (setup scripts, hooks, instructions, variables, files, repositories, MCP servers, skills) takes an org key: an admin makes one under Settings → Org → API keys.";
}

/** boxSetupRefusal as the API's 403, or null when the caller may. */
export function boxSetupRefused(context: { caller: { kind: ApiCallerKind } }): Response | null {
  const refusal = boxSetupRefusal(context.caller.kind);
  return refusal ? apiError(403, refusal) : null;
}

/** Where a call names its org: `?org=`, or the `Outrunner-Org` header. */
export function wantedOrg(request: Request): string | null {
  const named = new URL(request.url).searchParams.get("org") ?? request.headers.get("outrunner-org");
  return named?.trim() || null;
}
