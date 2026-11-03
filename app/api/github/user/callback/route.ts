import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { githubAccountConnectedElsewhere, saveGithubConnection } from "@/lib/db/github-connections";
import { appSlug, githubAppConfig, installUrl, signInstallState } from "@/lib/github/app";
import { appClientSecret } from "@/lib/github/installer";
import { removeLegacyToken } from "@/lib/github/legacy-token";
import { linkOwnInstallation } from "@/lib/github/own-installation";
import {
  CONNECT_COOKIE,
  DESKTOP_LOOPBACK_REDIRECT,
  exchangeUserCode,
  nonceMatches,
  readConnectCookie,
  readConnectState,
  revokeGrant,
  revokeToken,
  USER_CALLBACK_PATH,
  userOfToken,
} from "@/lib/github/user-auth";
import { appUrl } from "@/lib/orgs/notify";

/**
 * Back from authorizing the Outrunner GitHub App to act as the user
 * (app/api/github/user/connect), in a browser, or forwarded by the desktop
 * shell's /auth/callback. Kept only when every part holds: the state is ours
 * and fresh, this browser started it (the cookie's nonce), the same user is
 * signed in, GitHub takes the code with this browser's PKCE verifier, and the
 * GitHub account is the one they sign in with (when they do).
 *
 * Then the old sign-in token, if they have one, is removed (and revoked on
 * GitHub where that can be done), and the App's installation on their own
 * account is linked to their personal org, or, with none yet, they're sent to
 * install it, which is where GitHub has them pick All or Selected
 * repositories.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const config = githubAppConfig();
  const clientSecret = appClientSecret();
  const jar = await cookies();
  const kept = readConnectCookie(jar.get(CONNECT_COOKIE)?.value);
  // Used once, whatever happens next.
  jar.set(CONNECT_COOKIE, "", { path: "/api/github/user", maxAge: 0 });

  const state = config ? readConnectState(config.webhookSecret, url.searchParams.get("state")) : null;
  const next = state?.next ?? "/settings/connections";
  const back = (code: string) => NextResponse.redirect(appUrl(`${next}?github=${code}`, url.origin), { status: 303 });
  if (!config || !clientSecret) return back("not_configured");
  if (!state) return back("link_expired");

  const owner = await getOwner();
  if (!owner) return NextResponse.redirect(appUrl(`/signin?next=${encodeURIComponent(next)}`, url.origin));
  if (owner.id !== state.userId || !nonceMatches(state, kept)) return back("link_expired");
  // Cancelled on GitHub.
  if (url.searchParams.get("error")) return back("declined");
  const code = url.searchParams.get("code");
  if (!code || !kept) return back("declined");

  try {
    const tokens = await exchangeUserCode(config, clientSecret, {
      code,
      redirectUri: state.desktop ? DESKTOP_LOOPBACK_REDIRECT : appUrl(USER_CALLBACK_PATH, url.origin),
      verifier: kept.verifier,
    });
    if (!tokens) return back("link_expired");
    const github = await userOfToken(tokens.accessToken);
    // Pushes and pull requests show as this account, and `@outrunner` goes
    // by the one they sign in with: the same one, where they sign in with
    // GitHub at all.
    if (owner.githubId !== null && owner.githubId !== github.id) {
      // Nothing is wanted of that account: its whole authorization goes, so
      // it isn't left among its Authorized GitHub Apps. Unless another
      // Outrunner user connected it: the grant is theirs too, so only this
      // token goes.
      const client = { clientId: config.clientId, clientSecret };
      if (await githubAccountConnectedElsewhere(github.id, owner.id)) await revokeToken(client, tokens.accessToken);
      else await revokeGrant(client, tokens.accessToken);
      return back("other_account");
    }
    await saveGithubConnection(owner.id, github, tokens);
    if (!tokens.accessExpiresAt) {
      console.warn("The GitHub App's user tokens don't expire: turn on \"Expire user authorization tokens\" (docs/github-app.md)");
    }

    // The old sign-in token is no longer used: gone, and revoked where it can be.
    await removeLegacyToken(owner.id).catch((error: unknown) =>
      console.error(`Could not remove user ${owner.id}'s old GitHub sign-in token`, error),
    );

    const outcome = await linkOwnInstallation(owner, github, tokens.accessToken).catch((error: unknown) => {
      console.error(`Could not link user ${owner.id}'s own GitHub App installation`, error);
      return null;
    });
    if (outcome?.next === "install") {
      // GitHub has them pick All or Selected repositories, and comes back to
      // the setup route (app/api/github/app/setup), which links it.
      return NextResponse.redirect(
        installUrl(await appSlug(config), signInstallState(config.webhookSecret, { orgId: outcome.orgId, userId: owner.id, next })),
        { status: 303 },
      );
    }
    return back("connected");
  } catch (error) {
    console.error(`Could not connect GitHub for user ${owner.id}`, error);
    return back("failed");
  }
}
