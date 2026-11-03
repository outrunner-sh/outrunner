import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { deleteGithubConnection, getGithubConnection } from "@/lib/db/github-connections";
import { githubAppConfig } from "@/lib/github/app";
import { appClientSecret } from "@/lib/github/installer";
import { revokeGrant } from "@/lib/github/user-auth";
import { GitHubConnectionBrokenError } from "@/lib/github/user-connection";
import { githubUserToken } from "@/lib/github/user-connection.deps";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";

/**
 * Disconnect the user's GitHub (Settings → Connections → GitHub): the
 * Outrunner GitHub App's authorization to act as them is revoked on GitHub,
 * every token of it, and forgotten here. Their sign-in and the App's
 * installations stay as they are (an installation is uninstalled on GitHub).
 */
export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  return savingSettings("GitHub connection", async () => {
    let revoked = false;
    const config = githubAppConfig();
    const clientSecret = appClientSecret();
    if ((await getGithubConnection(owner.id)) && config && clientSecret) {
      // Revoking takes a token that works: renewed first if it's due.
      const token = await githubUserToken(owner.id).catch((error: unknown) => {
        if (!(error instanceof GitHubConnectionBrokenError)) console.warn("Disconnecting GitHub: no token to revoke with", error);
        return null;
      });
      if (token) revoked = await revokeGrant({ clientId: config.clientId, clientSecret }, token.token);
    }
    await deleteGithubConnection(owner.id);
    return NextResponse.json({ disconnected: true, revoked });
  });
}
