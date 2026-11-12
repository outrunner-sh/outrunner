import { randomUUID } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { appUrl } from "@/lib/orgs/notify";
import { JIRA_COOKIE_PATH, JIRA_NONCE_COOKIE, jiraAuthorizeUrl, jiraConfig, signJiraState } from "@/lib/trackers/jira";

/**
 * Link the signed-in user's Jira account: off to sign in to Atlassian as themselves. A link
 * is only ever made from that sign-in (app/api/integrations/jira/callback), never from a
 * typed ID or a matching email.
 */
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const owner = await getOwner();
  if (!owner) return NextResponse.redirect(appUrl("/signin?next=/settings/integrations", origin), { status: 303 });
  const config = jiraConfig();
  if (!config) return NextResponse.redirect(appUrl("/settings/integrations?jira=unavailable", origin), { status: 303 });

  const nonce = randomUUID();
  const jar = await cookies();
  jar.set(JIRA_NONCE_COOKIE, nonce, { path: JIRA_COOKIE_PATH, httpOnly: true, secure: true, sameSite: "lax", maxAge: 600 });
  const state = signJiraState({ kind: "link", ownerId: owner.id, orgId: null, nonce }, config.clientSecret);
  return NextResponse.redirect(jiraAuthorizeUrl(config, "link", state), { status: 303 });
}
