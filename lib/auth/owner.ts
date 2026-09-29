import type { User } from "@supabase/supabase-js";

import { parseAllowlist } from "@/lib/auth/allowlist";
import { optionalEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type Owner = {
  id: string;
  githubLogin: string;
  email: string | null;
  avatarUrl: string | null;
};

/**
 * Whether this user may use the deployment.
 *
 * Sign-up is open: anyone who authenticates with GitHub gets in. What keeps
 * users apart is not this check but the data model — every row carries
 * `owner_id` and RLS restricts it to `auth.uid()`, so each account sees only
 * its own projects and workspaces, and each runs on credentials it supplied
 * itself (see lib/db/credentials.ts).
 *
 * Requiring a GitHub identity is still meaningful. {@link githubLogin} reads
 * `identities[]`, so this returns true only for a session that actually came
 * from GitHub — not one minted through some other provider that happens to be
 * enabled on the Supabase project.
 *
 * `RUNTIME_OWNER_GITHUB_LOGIN` narrows access back to a named allowlist when
 * set. Leave it unset for open sign-up; set it to keep a deployment private.
 * Note the polarity: unset means OPEN here, where it used to mean CLOSED.
 */
export function isOwner(user: User): boolean {
  const login = githubLogin(user)?.toLowerCase();
  if (login == null) return false;

  const allowed = parseAllowlist(optionalEnv("RUNTIME_OWNER_GITHUB_LOGIN"));
  return allowed.size === 0 || allowed.has(login);
}

/**
 * The GitHub username, read from the server-maintained OAuth identity — NOT
 * from `user_metadata`.
 *
 * `user_metadata` is writable by the user (`auth.updateUser({ data })`), so if
 * any other Supabase provider is enabled (email/password, magic link, …) a
 * non-GitHub user could set `user_name` to the owner's login and pass the
 * allowlist. `identities[].identity_data` is populated by GoTrue from the
 * provider on each sign-in and is not client-writable, and requiring a
 * `github` identity also enforces that the session actually came from GitHub.
 */
export function githubLogin(user: User): string | null {
  const identity = user.identities?.find((i) => i.provider === "github");
  if (!identity) return null;

  const data = (identity.identity_data ?? {}) as Record<string, unknown>;
  const login = data.user_name ?? data.preferred_username ?? data.login;
  return typeof login === "string" ? login : null;
}

/** The signed-in owner, or null when signed out or not the allowlisted user. */
export async function getOwner(): Promise<Owner | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isOwner(user)) return null;

  const meta = user.user_metadata as Record<string, unknown> | null;
  return {
    id: user.id,
    githubLogin: githubLogin(user) ?? "",
    email: user.email ?? null,
    avatarUrl:
      typeof meta?.avatar_url === "string" ? meta.avatar_url : null,
  };
}

/**
 * Like {@link getOwner} but never throws. Before Supabase is configured the
 * server client throws on missing env; UI (the app shell, the sign-in page)
 * must still render and guide configuration, so it treats any failure as
 * "signed out".
 */
export async function getOwnerSafe(): Promise<Owner | null> {
  try {
    return await getOwner();
  } catch {
    return null;
  }
}
