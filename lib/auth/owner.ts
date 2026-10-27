
import type { User } from "@supabase/supabase-js";
import { cache } from "react";

import { githubLogin, githubUserId, isOwner } from "@/lib/auth/allowlist";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type Owner = {
  id: string;
  githubLogin: string;
  /** The GitHub user's numeric id (lib/auth/allowlist.ts githubUserId):
   *  never renamed, never reused. Null when the identity doesn't say. */
  githubId: number | null;
  /** The user's full name from GitHub, or their login if not set. */
  name: string;
  email: string | null;
  avatarUrl: string | null;
};

/**
 * The signed-in Supabase user, checked with Supabase Auth (getUser(), not the
 * cookie's own say-so), or null. Asked once per server render however many
 * readers there are (the layout, the page, onboarding): React `cache`. A route
 * handler asks once anyway.
 */
export const getAuthUser = cache(async (): Promise<User | null> => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/** The signed-in owner, or null when signed out or not the allowlisted user. */
export async function getOwner(): Promise<Owner | null> {
  const user = await getAuthUser();

  if (!user || !isOwner(user)) return null;
  return ownerFromUser(user);
}

/** The owner a Supabase user is, as the app shows them. */
export function ownerFromUser(user: User): Owner {
  const meta = user.user_metadata as Record<string, unknown> | null;
  const login = githubLogin(user) ?? "";
  // GitHub provides full_name or name in user_metadata from OAuth
  const name =
    (typeof meta?.full_name === "string" && meta.full_name) ||
    (typeof meta?.name === "string" && meta.name) ||
    login;
  return {
    id: user.id,
    githubLogin: login,
    githubId: githubUserId(user),
    name,
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

export { githubLogin, isOwner };
