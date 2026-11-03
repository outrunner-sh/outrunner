import type { User } from "@supabase/supabase-js";

import { isOwner } from "@/lib/auth/allowlist";
import { clearGithubToken } from "@/lib/db/credentials";
import { deleteGithubConnection } from "@/lib/db/github-connections";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * End the visit of someone an invite signed in who isn't let in
 * (lib/orgs/admission.ts): its invite was withdrawn, expired, or isn't to
 * them. Signed out, and the GitHub token their sign-in stored forgotten, so
 * nothing of theirs lingers for an account that never joined. Anyone the
 * allowlist lets in is left as they are. Never throws.
 */
export async function endInviteeVisit(user: User | null): Promise<void> {
  if (!user || isOwner(user)) return;
  await clearGithubToken(user.id).catch((error: unknown) =>
    console.error(`Could not forget ${user.id}'s GitHub token`, error),
  );
  await deleteGithubConnection(user.id).catch((error: unknown) =>
    console.error(`Could not forget ${user.id}'s GitHub connection`, error),
  );
  try {
    await (await createSupabaseServerClient()).auth.signOut();
  } catch (error) {
    console.error(`Could not sign ${user.id} out`, error);
  }
}
