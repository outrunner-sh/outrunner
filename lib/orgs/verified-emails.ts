import type { User } from "@supabase/supabase-js";

import { mergeVerifiedEmails, providerVerifiedEmails } from "@/lib/auth/identity";
import { listVerifiedEmails, MissingGithubTokenError } from "@/lib/github/client";
import type { VerifiedEmail } from "@/lib/orgs/domains";

/**
 * The emails verified for a user, by GitHub, by Google, and by an emailed
 * sign-in code. Invites, join requests and a team org's domain all go by
 * these.
 *
 * GitHub's are read live with `githubToken` when there is one (a sign-in's
 * own, at the callback; an old sign-in token kept from before), else they're
 * the ones GitHub verified at the user's last GitHub sign-in (`kept`): signing
 * in no longer keeps a token to ask with later.
 *
 * Throws {@link MissingGithubTokenError} (or GitHub's refusal) when none can
 * vouch for an email: a GitHub-only user with nothing kept has to sign in
 * with GitHub again.
 */
export async function verifiedEmailsFor(
  user: User,
  githubToken: string | undefined,
  kept: readonly VerifiedEmail[] = [],
): Promise<VerifiedEmail[]> {
  const others = providerVerifiedEmails(user);
  const fallback = () => {
    const emails = mergeVerifiedEmails(kept, others);
    if (emails.length === 0) throw new MissingGithubTokenError();
    return emails;
  };
  if (!githubToken) return fallback();
  // A stored token may since have been revoked: what was kept, and the other
  // providers' emails, still vouch for the user; only with none does that
  // stop them.
  try {
    return mergeVerifiedEmails(await listVerifiedEmails(githubToken), others);
  } catch (error) {
    if (kept.length === 0 && others.length === 0) throw error;
    return fallback();
  }
}
