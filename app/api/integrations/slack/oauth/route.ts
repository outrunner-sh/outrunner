import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { memberRole } from "@/lib/db/orgs";
import { saveSlackLink } from "@/lib/db/slack-links";
import { slackSignInMatches, verifyLinkToken, verifySignInState } from "@/lib/slack/slack";
import { SLACK_SIGNIN_COOKIE, SLACK_SIGNIN_PATH, slackSignInConfig } from "@/lib/slack/sign-in";

/**
 * Where Sign in with Slack comes back to, to finish linking a Slack user
 * (app/slack/link). Linked only when every part holds: the state is ours and
 * fresh, this browser started it (the nonce cookie), the same Outrunner user
 * is signed in and still in the org they picked, and Slack says the person
 * who signed in is the Slack user the link names. So a link forwarded to
 * someone else links no one.
 */
export async function GET(request: Request) {
  const done = (result: string) =>
    NextResponse.redirect(new URL(`/settings/integrations?slack=${result}`, request.url), { status: 303 });
  const config = slackSignInConfig();
  if (!config) return done("unavailable");

  const url = new URL(request.url);
  const jar = await cookies();
  const nonce = jar.get(SLACK_SIGNIN_COOKIE)?.value;
  // Used once, whatever happens next.
  jar.set(SLACK_SIGNIN_COOKIE, "", { path: SLACK_SIGNIN_PATH, maxAge: 0 });
  if (url.searchParams.get("error")) return done("cancelled");
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
