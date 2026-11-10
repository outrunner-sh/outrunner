import type { User } from "@supabase/supabase-js";

import { getGithubVerifiedEmails } from "@/lib/db/credentials";
import { usableLegacyToken } from "@/lib/github/legacy-token";
import type { VerifiedEmail } from "@/lib/orgs/domains";
import { verifiedEmailsFor } from "@/lib/orgs/verified-emails";

/**
 * {@link verifiedEmailsFor} for a signed-in user after their sign-in: with
 * an old sign-in token where one may still be used, else the emails GitHub
 * verified when they last signed in with it.
 */
export async function verifiedEmailsOf(user: User): Promise<VerifiedEmail[]> {
  const [token, kept] = await Promise.all([
    usableLegacyToken(user.id).catch(() => null),
    getGithubVerifiedEmails(user.id).catch((error: unknown) => {
      console.error(`Could not read the GitHub emails kept for ${user.id}`, error);
      return [];
    }),
  ]);
  return verifiedEmailsFor(user, token ?? undefined, kept);
}
