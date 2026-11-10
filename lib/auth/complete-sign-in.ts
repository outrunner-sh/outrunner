import type { User } from "@supabase/supabase-js";

import { githubUserId } from "@/lib/auth/allowlist";
import { signInTokenDecision } from "@/lib/auth/identity";
import { githubLogin, isOwner } from "@/lib/auth/owner";
import { sameSecret } from "@/lib/crypto/secret-box";
import { getGithubToken, getGithubVerifiedEmails, setGithubToken, setGithubVerifiedEmails } from "@/lib/db/credentials";
import { githubConnectionStatus } from "@/lib/db/github-connections";
import { hasOpenInviteFor, requestToJoin, setAdmitted, teamOrgIds } from "@/lib/db/org-members";
import { orgsForDomains } from "@/lib/db/orgs";
import { optionalEnv } from "@/lib/env";
import { listVerifiedEmails, tokenOwner } from "@/lib/github/client";
import { legacyTokenMode, revokeSignInToken } from "@/lib/github/legacy-token";
import { admitOnSignIn, type Admission, isInvitePath } from "@/lib/orgs/admission";
import { emailJoinRequest } from "@/lib/orgs/notify";
import { verifiedEmailsFor } from "@/lib/orgs/verified-emails";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

type ServerSupabase = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/**
 * What every sign-in does once Supabase has a session for it, whichever way
 * it came (OAuth at /auth/callback, an emailed code at /auth/email): enforce
 * the allowlist, keep the emails GitHub verified (the GitHub token itself
 * only in GITHUB_LEGACY_TOKENS `store` mode), and say where to go next —
 * `next`, or back to /signin with why not.
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

  await captureGithubSignIn(user, githubToken);
  return `${base}${next}`;
}

/** Let a user the allowlist doesn't name in, if an org does; refused when
 *  that can't be worked out (no verified email to go by, GitHub down). */
async function admit(user: User, githubToken: string | undefined, base: string): Promise<Admission> {
  try {
    return await admitOnSignIn({
      inTeamOrg: async () => (await teamOrgIds(user.id)).length > 0,
      verifiedEmails: async () =>
        verifiedEmailsFor(user, githubToken, githubToken ? [] : await getGithubVerifiedEmails(user.id).catch(() => [])),
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
 * What a GitHub sign-in (or GitHub connection) leaves behind. A Google
 * sign-in produces no GitHub token: its provider_token is Google's.
 *
 * Signing in with GitHub is identity alone: its token (`read:user
 * user:email`) is used here, once, to read the emails GitHub verified, which
 * are kept for invites, join requests and a team org's domain, and is then
 * revoked where the OAuth App's credentials are set (lib/github/legacy-token.ts).
 * Repository access is a separate connection (Settings → Connections).
 *
 * Only in GITHUB_LEGACY_TOKENS `store` mode is the token itself kept, as
 * before: Supabase surfaces `provider_token` on the session returned by the
 * code exchange and never stores or refreshes it, so this is the one place
 * it can be kept.
 *
 * Either is kept only as GitHub vouches for the token ({@link signInTokenDecision}):
 * the callback picks the token by which identity signed in last, and a wrong
 * pick (a Google token, say) must never be taken for the account's. When
 * GitHub can't be asked (an outage), a token is stored only if none is yet.
 *
 * Best-effort by design: a storage failure must not strand a user who has
 * otherwise signed in successfully.
 */
async function captureGithubSignIn(user: User, token: string | undefined): Promise<void> {
  const login = githubLogin(user);
  const githubId = githubUserId(user);
  if (!token || !login || githubId === null) return;
  const store = legacyTokenMode() === "store";
  const owner = await tokenOwner(token);

  if (owner.kind === "user" && owner.id === githubId) {
    try {
      await setGithubVerifiedEmails(user.id, await listVerifiedEmails(token));
    } catch (err) {
      console.error(`Could not keep the GitHub emails of ${user.id}; sign-in continues.`, err);
    }
  }
  if (!store) {
    // Nothing keeps it: revoke it, unless it's the old token still kept
    // (GitHub can hand the same one back), which works until it's removed.
    const kept = await getGithubToken(user.id).catch(() => null);
    if (owner.kind === "user" && owner.id === githubId && !(kept && sameSecret(kept, token))) await revokeSignInToken(token);
    return;
  }

  // A user connected through the App works on repositories as that
  // connection, and connecting removed their old token: keeping a fresh one
  // would bring it back. Only a working connection counts; an unreadable one
  // keeps the token, as before.
  const connection = await githubConnectionStatus(user.id).catch(() => null);
  if (connection && !connection.broken) return;

  // Whether one is stored matters only when GitHub couldn't be asked.
  const hasStored = owner.kind === "unreachable" && (await getGithubToken(user.id).catch(() => null)) !== null;
  const decision = signInTokenDecision(owner, githubId, hasStored);
  // Each of these is worth an alert: a wrong pick, or GitHub out of reach.
  if (decision === "disowned") {
    console.error(`Not storing a sign-in token for ${user.id}: GitHub doesn't vouch for it as their account's.`);
    return;
  }
  if (decision === "keep_stored") {
    console.error(`GitHub couldn't be asked whose ${user.id}'s sign-in token is; keeping the stored one.`);
    return;
  }
  if (owner.kind === "unreachable") {
    console.error(`GitHub couldn't be asked whose ${user.id}'s sign-in token is; none is stored, so storing it.`);
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
