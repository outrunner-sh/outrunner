import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { githubAppConfig } from "@/lib/github/app";
import { appClientSecret } from "@/lib/github/installer";
import {
  CONNECT_COOKIE,
  DESKTOP_LOOPBACK_REDIRECT,
  isConnectReturn,
  newConnectSecrets,
  signConnectState,
  USER_CALLBACK_PATH,
  userAuthorizeUrl,
} from "@/lib/github/user-auth";
import { appUrl } from "@/lib/orgs/notify";

/** How long the browser keeps a connect's nonce and verifier. */
const CONNECT_COOKIE_SECONDS = 15 * 60;

/**
 * Connect (or reconnect) GitHub for the signed-in user's own repositories
 * (Settings → Connections → GitHub): off to GitHub to authorize the Outrunner
 * GitHub App to act as them, coming back to app/api/github/user/callback with
 * a code that only this browser can trade (a nonce and a PKCE verifier in a
 * cookie, the state signed). No sign-out, and the sign-in stays as it is.
 *
 * `?desktop=1` is the desktop shell's: GitHub opens in the system browser and
 * comes back through the shell's loopback listener to its webview's
 * /auth/callback, which forwards the code here. `?format=json` answers the
 * address rather than going there, for the shell's webview to open it.
 * `?account=choose` lets them pick another GitHub account than the one
 * they're signed in to on GitHub.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = url.searchParams.get("next");
  const next = isConnectReturn(requested) ? requested : "/settings/connections";
  const json = url.searchParams.get("format") === "json";
  const back = (code: string) => {
    const to = appUrl(`${next}?github=${code}`, url.origin);
    return json ? NextResponse.json({ error: code, url: to }, { status: 409 }) : NextResponse.redirect(to);
  };

  const owner = await getOwner();
  if (!owner) {
    const signIn = appUrl(`/signin?next=${encodeURIComponent(next)}`, url.origin);
    return json ? NextResponse.json({ error: "signed_out", url: signIn }, { status: 401 }) : NextResponse.redirect(signIn);
  }
  const config = githubAppConfig();
  if (!config || !appClientSecret()) return back("not_configured");

  const desktop = url.searchParams.get("desktop") === "1";
  const { nonce, verifier, cookie } = newConnectSecrets();
  const state = signConnectState(config.webhookSecret, { userId: owner.id, nonce, desktop, next });
  const authorize = userAuthorizeUrl({
    clientId: config.clientId,
    redirectUri: desktop ? DESKTOP_LOOPBACK_REDIRECT : appUrl(USER_CALLBACK_PATH, url.origin),
    state,
    verifier,
    selectAccount: url.searchParams.get("account") === "choose",
  });

  const response = json ? NextResponse.json({ url: authorize }) : NextResponse.redirect(authorize);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set(CONNECT_COOKIE, cookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: appUrl("", url.origin).startsWith("https:"),
    path: "/api/github/user",
    maxAge: CONNECT_COOKIE_SECONDS,
  });
  return response;
}
