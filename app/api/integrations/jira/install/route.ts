import { randomUUID } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { appUrl } from "@/lib/orgs/notify";
import { getOrgContext } from "@/lib/orgs/server";
import { JIRA_COOKIE_PATH, JIRA_NONCE_COOKIE, jiraAuthorizeUrl, jiraConfig, signJiraState } from "@/lib/trackers/jira";

/**
 * Connect a Jira site for the org the app is showing: off to Atlassian, to authorize as the
 * site's dedicated Outrunner account, carrying a signed state that names the org and its
 * admin, which app/api/integrations/jira/callback checks on the way back. The org's admins
 * only.
 */
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const back = (code: string) => NextResponse.redirect(appUrl(`/settings/org/jira?jira=${code}`, origin), { status: 303 });
  const owner = await getOwner();
  if (!owner) return NextResponse.redirect(appUrl("/signin?next=/settings/org/jira", origin), { status: 303 });
  const config = jiraConfig();
  if (!config) return back("unavailable");
  const context = await getOrgContext().catch(() => null);
  if (!context || context.active.role !== "admin") return back("not_admin");

  const nonce = randomUUID();
  const jar = await cookies();
  jar.set(JIRA_NONCE_COOKIE, nonce, { path: JIRA_COOKIE_PATH, httpOnly: true, secure: true, sameSite: "lax", maxAge: 600 });
  const state = signJiraState({ kind: "install", ownerId: owner.id, orgId: context.active.id, nonce }, config.clientSecret);
  return NextResponse.redirect(jiraAuthorizeUrl(config, "install", state), { status: 303 });
}
