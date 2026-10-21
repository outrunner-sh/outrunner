
import type { User } from "@supabase/supabase-js";
import { cache } from "react";

import { githubLogin, isOwner } from "@/lib/auth/allowlist";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type Owner = {
  id: string;
  githubLogin: string;
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

export { githubLogin, isOwner };
