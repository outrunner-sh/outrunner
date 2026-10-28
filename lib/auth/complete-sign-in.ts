import type { User } from "@supabase/supabase-js";

import { githubUserId } from "@/lib/auth/allowlist";
import { githubLogin, isOwner } from "@/lib/auth/owner";
import { setGithubToken } from "@/lib/db/credentials";
import { hasOpenInviteFor, requestToJoin, setAdmitted, teamOrgIds } from "@/lib/db/org-members";
import { orgsForDomains } from "@/lib/db/orgs";
import { optionalEnv } from "@/lib/env";
import { tokenOwner } from "@/lib/github/client";
import { admitOnSignIn, type Admission, isInvitePath } from "@/lib/orgs/admission";
import { emailJoinRequest } from "@/lib/orgs/notify";
import { verifiedEmailsFor } from "@/lib/orgs/verified-emails";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

type ServerSupabase = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/**
 * What every sign-in does once Supabase has a session for it, whichever way
 * it came (OAuth at /auth/callback, an emailed code at /auth/email): enforce
 * the allowlist, store a GitHub token the sign-in produced, and say where to
 * go next — `next`, or back to /signin with why not.
 *
 * Access may be allowlisted: anyone whose GitHub login isn't in
 * RUNTIME_OWNER_GITHUB_LOGIN is signed straight back out, unless an org lets
 * them in, or will: an invite to them gets them as far as its page, and they
 * ask to join the org that claimed their email's domain
 * (lib/orgs/admission.ts).
 */
export async function completeSignIn({
  supabase,
  user,
  githubToken,
  base,
  next,
}: {
  /** The client that made the session, to end it with. */
  supabase: ServerSupabase;
  user: User;
  /** The GitHub token this sign-in produced, if it went through GitHub. */
  githubToken: string | undefined;
  base: string;
  next: string;
}): Promise<string> {
  if (!isOwner(user)) {
    const admission = await admit(user, githubToken, base);
    // On the way to their invite: signed in, for its page alone (it and its
    // accept route are all that ask for less than isOwner).
    const toInvite = admission.kind === "invited" && isInvitePath(next);
    if (admission.kind !== "admitted" && !toInvite) {
      await supabase.auth.signOut();
      if (admission.kind === "requested") return joinRequested(base, admission);
      return signInError(base, admission.kind === "invited" ? "invited" : "not_owner");
    }
  }

  await captureGithubToken(user, githubToken);
  return `${base}${next}`;
}

/** Let a user the allowlist doesn't name in, if an org does; refused when
 *  that can't be worked out (no verified email to go by, GitHub down). */
async function admit(user: User, githubToken: string | undefined, base: string): Promise<Admission> {
  try {
    return await admitOnSignIn({
      inTeamOrg: async () => (await teamOrgIds(user.id)).length > 0,
      verifiedEmails: () => verifiedEmailsFor(user, githubToken),
      hasOpenInviteFor,
      orgsForDomains,
      requestToJoin: (orgId, email) => requestToJoin(orgId, user.id, email),
      admit: () => setAdmitted(user.id, true),
      notifyAdmins: (org, email) => emailJoinRequest(org, email, base),
    });
  } catch (error) {
    console.error(`Could not work out whether an org lets ${user.id} in`, error);
    return { kind: "refused" };
  }
}

/** Back to sign-in, saying their request to join an org is with its admins. */
function joinRequested(base: string, admission: Extract<Admission, { kind: "requested" }>): string {
  const url = new URL(`${base}/signin`);
  url.searchParams.set("error", admission.outcome === "declined_recently" ? "join_declined" : "join_requested");
  url.searchParams.set("org", admission.org.name);
  return url.toString();
}

/**
 * Persist the GitHub access token this sign-in (or GitHub connection)
 * produced. A Google sign-in produces none: its provider_token is Google's.
 *
 * THIS IS THE ONLY PLACE IT IS AVAILABLE. Supabase surfaces `provider_token`
 * on the session returned by the code exchange and never stores or refreshes
 * it — `getSession()` later in the app returns nothing for it. Miss it here and
 * the user has to re-authenticate to get another one.
 *
 * Not stored when GitHub says the token isn't this user's GitHub account's:
 * the callback picks the token by which identity signed in last, and a wrong
 * pick (a Google token, say) must never replace a working GitHub token. When
 * GitHub can't be asked (an outage), the pick stands: it is right in the
 * common case, and this is the token's only chance to be kept.
 *
 * Best-effort by design: a storage failure must not strand a user who has
 * otherwise signed in successfully. They land in the app with no GitHub
 * connection, which the UI already has to handle anyway (a first sign-in before
 * the `repo` scope was granted looks identical), and the next sign-in retries.
 */
async function captureGithubToken(user: User, token: string | undefined): Promise<void> {
  const login = githubLogin(user);
  const githubId = githubUserId(user);
  if (!token || !login || githubId === null) return;
  const owner = await tokenOwner(token);
  if (owner.kind === "refused" || (owner.kind === "user" && owner.id !== githubId)) {
    // Only a token the callback took for GitHub's gets here: one GitHub
    // disowns means the pick was wrong, which is worth an alert.
    console.error(`Not storing a sign-in token for ${user.id}: GitHub doesn't vouch for it as their account's.`);
    return;
  }
  if (owner.kind === "unreachable") {
    console.error(`GitHub couldn't be asked whose ${user.id}'s sign-in token is; storing it as GitHub's.`);
  }

  try {
    await setGithubToken(user.id, token, login);
  } catch (err) {
    console.error(
      `Could not store the GitHub token for ${user.id}; ` +
        `sign-in continues without a GitHub connection.`,
      err,
    );
  }
}

/**
 * Absolute origin to redirect back to after signing in.
 *
 * `RUNTIME_BASE_URL` is mandatory in production because a forwarded host is a
 * request header and therefore cannot be trusted for an authenticated
 * redirect. Local development may safely use the request origin.
 */
export function redirectBase(requestUrl: URL): string {
  const configured = optionalEnv("RUNTIME_BASE_URL");
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("RUNTIME_BASE_URL must use http or https.");
    }
    return url.origin;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("RUNTIME_BASE_URL must be set in production.");
  }
  return requestUrl.origin;
}

/** Back to /signin, saying why (app/signin/page.tsx has the words). */
export function signInError(base: string, reason: string): string {
  const url = new URL(`${base}/signin`);
  url.searchParams.set("error", reason);
  return url.toString();
}
