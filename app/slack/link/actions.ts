"use server";

import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getOwner } from "@/lib/auth/owner";
import { memberRole } from "@/lib/db/orgs";
import { isUuid } from "@/lib/ids";
import { signSignInState, slackAuthorizeUrl, verifyLinkToken } from "@/lib/slack/slack";
import { SLACK_SIGNIN_COOKIE, SLACK_SIGNIN_PATH, slackSignInConfig } from "@/lib/slack/sign-in";

/**
 * The user picked an org on /slack/link: sign in with Slack, as the Slack
 * user the link names, to finish (app/api/integrations/slack/oauth). The link
 * and the org are checked again here, since the form is the browser's to
 * change.
 */
export async function startSlackLink(formData: FormData) {
  const token = formData.get("t")?.toString() ?? "";
  const orgId = formData.get("org")?.toString() ?? "";
  const config = slackSignInConfig();
  if (!config) redirect(`/slack/link?t=${encodeURIComponent(token)}`);
  const identity = verifyLinkToken(token, config.secret);
  if (!identity) redirect(`/slack/link?t=${encodeURIComponent(token)}`);
  const owner = await getOwner();
  if (!owner) redirect("/signin");
  if (!isUuid(orgId) || !(await memberRole(orgId, owner.id))) redirect(`/slack/link?t=${encodeURIComponent(token)}`);

  const nonce = randomBytes(24).toString("base64url");
  (await cookies()).set(SLACK_SIGNIN_COOKIE, nonce, {
    path: SLACK_SIGNIN_PATH,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 10 * 60,
  });
  redirect(
    slackAuthorizeUrl({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state: signSignInState({ link: token, orgId, ownerId: owner.id, nonce }, config.secret),
      nonce,
      teamId: identity.teamId,
    }),
  );
}
