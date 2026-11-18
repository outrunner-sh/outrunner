import { githubLogin, isOwner } from "@/lib/auth/allowlist";
import { getAuthUser } from "@/lib/auth/owner";
import type { OnboardingUser } from "@/lib/onboarding/types";

/**
 * Setup's view of the signed-in user, from Supabase auth: who they are.
 * Null when signed out. Whether they're sent through setup is their active
 * org's (lib/orgs/setup.ts), not theirs: setup runs per org.
 */
export async function getOnboardingUser(): Promise<OnboardingUser | null> {
  const user = await getAuthUser();
  if (!user || !isOwner(user)) return null;

  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof meta[key] === "string" && meta[key] ? (meta[key] as string) : null);
  const login = githubLogin(user) ?? "";
  return {
    id: user.id,
    name: text("full_name") ?? text("name") ?? login,
    login,
    avatarUrl: text("avatar_url"),
  };
}
