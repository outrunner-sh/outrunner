import { githubLogin, isOwner } from "@/lib/auth/allowlist";
import { getAuthUser } from "@/lib/auth/owner";
import { listWorkspacesOnce } from "@/lib/db/request-cache";
import type { OnboardingUser } from "@/lib/onboarding/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Onboarding's view of the signed-in user, from Supabase auth: who they are,
 * and whether they have finished (or skipped) onboarding. That is a mark in
 * their user_metadata, so it needs no table and follows them to any device.
 * Null when signed out.
 */
export async function getOnboardingUser(): Promise<
  (OnboardingUser & { onboardedAt: string | null }) | null
> {
  const user = await getAuthUser();
  if (!user || !isOwner(user)) return null;

  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof meta[key] === "string" && meta[key] ? (meta[key] as string) : null);
  const login = githubLogin(user) ?? "";
  return {
    name: text("full_name") ?? text("name") ?? login,
    login,
    avatarUrl: text("avatar_url"),
    onboardedAt: text("onboarded_at"),
  };
}

/**
 * Whether the signed-in user is new and belongs in onboarding: no session yet,
 * and no mark that they finished or skipped it. Anyone with a session is past
 * it, marked or not. Only a list that really loaded empty counts: a failed read
 * must not send an existing user there.
 */
export async function needsOnboarding(): Promise<boolean> {
  const workspaces = await listWorkspacesOnce().catch(() => null);
  if (!workspaces || workspaces.length > 0) return false;
  const user = await getOnboardingUser().catch(() => null);
  return user !== null && !user.onboardedAt;
}

/** Record that the signed-in user is done with onboarding. */
export async function markOnboarded(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({
    data: { onboarded_at: new Date().toISOString() },
  });
  if (error) throw error;
}
