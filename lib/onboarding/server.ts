import { githubLogin, isOwner } from "@/lib/auth/allowlist";
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
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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

/** Record that the signed-in user is done with onboarding. */
export async function markOnboarded(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({
    data: { onboarded_at: new Date().toISOString() },
  });
  if (error) throw error;
}
