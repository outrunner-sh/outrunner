import type { User } from "@supabase/supabase-js";

import { mergeVerifiedEmails, providerVerifiedEmails } from "@/lib/auth/identity";
import { listVerifiedEmails, MissingGithubTokenError } from "@/lib/github/client";
import type { VerifiedEmail } from "@/lib/orgs/domains";

/**
 * The emails verified for a user, by GitHub (with their GitHub token, when
 * they have one), by Google, and by an emailed sign-in code.
 * Invites, join requests and a team org's domain all go by these.
 *
 * Throws {@link MissingGithubTokenError} when none can vouch for an email:
 * a GitHub-only user whose token is gone has to reconnect, as before.
 */
export async function verifiedEmailsFor(user: User, githubToken: string | undefined): Promise<VerifiedEmail[]> {
  const others = providerVerifiedEmails(user);
  if (!githubToken) {
    if (others.length === 0) throw new MissingGithubTokenError();
    return others;
  }
  return mergeVerifiedEmails(await listVerifiedEmails(githubToken), others);
}
