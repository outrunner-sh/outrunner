import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { memberRole } from "@/lib/db/orgs";
import { saveInstallation } from "@/lib/db/slack-agent";
import { optionalEnv } from "@/lib/env";
import { saveSlackLink } from "@/lib/db/slack-links";
import { slackSignInMatches, verifyLinkToken, verifySignInState } from "@/lib/slack/slack";
import { SLACK_SIGNIN_COOKIE, SLACK_SIGNIN_PATH, slackSignInConfig } from "@/lib/slack/sign-in";

/**
 * Where Sign in with Slack comes back to, to finish linking a Slack user
 * (and where the app's install link lands, to finish installing it)
 * (app/slack/link). Linked only when every part holds: the state is ours and
 * fresh, this browser started it (the nonce cookie), the same Outrunner user
 * is signed in and still in the org they picked, and Slack says the person
 * who signed in is the Slack user the link names. So a link forwarded to
 * someone else links no one.
 */
export async function GET(request: Request) {
  // The app's own address: behind Cloudflare, the request's is the
  // container's (localhost), which the browser can't reach.
  const done = (result: string) =>
    NextResponse.redirect(new URL(`/settings/integrations?slack=${result}`, optionalEnv("RUNTIME_BASE_URL") || request.url), {
      status: 303,
    });
  const config = slackSignInConfig();
  if (!config) return done("unavailable");

  const url = new URL(request.url);
  const jar = await cookies();
  const nonce = jar.get(SLACK_SIGNIN_COOKIE)?.value;
  // Used once, whatever happens next.
  jar.set(SLACK_SIGNIN_COOKIE, "", { path: SLACK_SIGNIN_PATH, maxAge: 0 });
  if (url.searchParams.get("error")) return done("cancelled");
  // The app's install link comes back here too, with a code and an empty
  // state (Slack sends installs to the first redirect URL); a sign-in always
  // carries ours. The install only takes once the code is traded, and the bot
  // token it gives is what the Slack agent posts with.
  if (!url.searchParams.get("state") && url.searchParams.get("code")) {
    return done((await finishInstall(config, url.searchParams.get("code") ?? "")) ? "installed" : "failed");
  }
  const state = verifySignInState(url.searchParams.get("state"), config.secret);
  const code = url.searchParams.get("code");
  if (!state || !code || !nonce || state.nonce !== nonce) return done("expired");
  const identity = verifyLinkToken(state.link, config.secret);
  if (!identity) return done("expired");
  const owner = await getOwner();
  if (!owner || owner.id !== state.ownerId) return done("expired");
  if (!(await memberRole(state.orgId, owner.id))) return done("expired");

  const response = await fetch("https://slack.com/api/openid.connect.token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  }).catch(() => null);
  const answer = (await response?.json().catch(() => null)) as { ok?: boolean; id_token?: unknown } | null;
  if (!answer?.ok) return done("failed");
  if (!slackSignInMatches(answer.id_token, { clientId: config.clientId, nonce, identity })) return done("mismatch");

  await saveSlackLink(identity, owner.id, state.orgId);
  return done("linked");
}

/** Trade an install's code, which is what completes the app's install, and
 *  keep the bot token it gives: what the Slack agent posts with. */
async function finishInstall(
  config: { clientId: string; clientSecret: string; redirectUri: string },
  code: string,
): Promise<boolean> {
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  }).catch(() => null);
  const answer = (await response?.json().catch(() => null)) as {
    ok?: boolean;
    access_token?: string;
    token_type?: string;
    bot_user_id?: string;
    team?: { id?: string; name?: string };
  } | null;
  if (!answer?.ok) return false;
  if (answer.token_type === "bot" && answer.access_token && answer.bot_user_id && answer.team?.id) {
    await saveInstallation({
      teamId: answer.team.id,
      teamName: answer.team.name ?? null,
      botUserId: answer.bot_user_id,
      botToken: answer.access_token,
    });
  }
  return true;
}
