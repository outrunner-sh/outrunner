import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  deleteGithubConnection,
  getGithubConnection,
  markGithubConnectionBroken,
  saveRefreshedGithubTokens,
} from "@/lib/db/github-connections";
import { githubAppConfig } from "@/lib/github/app";
import { appClientSecret } from "@/lib/github/installer";
import { refreshUserTokens, revokeGrant } from "@/lib/github/user-auth";
import { GitHubConnectionBrokenError } from "@/lib/github/user-connection";
import { githubUserToken } from "@/lib/github/user-connection.deps";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";

/** Where a user revokes an App's authorization themselves. */
const AUTHORIZED_APPS_URL = "https://github.com/settings/apps/authorizations";

/**
 * Disconnect the user's GitHub (Settings → Connections → GitHub): the
 * Outrunner GitHub App's authorization to act as them is revoked on GitHub,
 * every token of it, and forgotten here. Their sign-in and the App's
 * installations stay as they are (an installation is uninstalled on GitHub).
 *
 * When GitHub can't be asked to revoke it, the connection is kept, no longer
 * used (broken), with its tokens to try again with, and the answer is an
 * error: the user isn't told it's gone while a token of it still works. With
 * no token left to revoke with, it's forgotten, `revoked: false` saying where
 * on GitHub to revoke it themselves.
 */
export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  return savingSettings("GitHub connection", async () => {
    const connection = await getGithubConnection(owner.id);
    const config = githubAppConfig();
    const clientSecret = appClientSecret();
    if (!connection) return NextResponse.json({ disconnected: true, revoked: true });
    if (!config || !clientSecret) {
      await deleteGithubConnection(owner.id);
      return NextResponse.json({ disconnected: true, revoked: false, revokeUrl: AUTHORIZED_APPS_URL });
    }
    const client = { clientId: config.clientId, clientSecret };

    // Revoking takes a token that works: renewed first if it's due. One kept
    // from a failed disconnect (broken) is used as it is while it lasts, or
    // renewed with its refresh token.
    let token = (
      await githubUserToken(owner.id).catch((error: unknown) => {
        if (!(error instanceof GitHubConnectionBrokenError)) console.warn("Disconnecting GitHub: no token to revoke with", error);
        return null;
      })
    )?.token;
    if (!token && connection.accessToken) {
      if (!connection.accessExpiresAt || connection.accessExpiresAt.getTime() > Date.now()) token = connection.accessToken;
      else if (connection.refreshToken) {
        const renewed = await refreshUserTokens(config, clientSecret, connection.refreshToken).catch(() => null);
        if (renewed && renewed !== "revoked") {
          token = renewed.accessToken;
          // Kept, so a retry after a failed revoke still has a token to use.
          if (connection.refreshCiphertext) await saveRefreshedGithubTokens(owner.id, connection.refreshCiphertext, renewed);
        }
      }
    }
    if (!token) {
      await deleteGithubConnection(owner.id);
      return NextResponse.json({ disconnected: true, revoked: false, revokeUrl: AUTHORIZED_APPS_URL });
    }
    if (!(await revokeGrant(client, token))) {
      await markGithubConnectionBroken(owner.id);
      return NextResponse.json(
        {
          error:
            "GitHub couldn't be reached to revoke Outrunner's access. Outrunner has stopped using it; try Disconnect again, or revoke it yourself under GitHub → Settings → Applications → Authorized GitHub Apps.",
          revokeUrl: AUTHORIZED_APPS_URL,
        },
        { status: 502 },
      );
    }
    await deleteGithubConnection(owner.id);
    return NextResponse.json({ disconnected: true, revoked: true });
  });
}
