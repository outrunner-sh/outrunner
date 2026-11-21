import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { ownOrgId } from "@/lib/db/orgs";
import { appSlug, githubAppConfig, installUrl, isInstallReturn, signInstallState } from "@/lib/github/app";
import { appUrl } from "@/lib/orgs/notify";

/**
 * Install the Outrunner GitHub App on another of the user's GitHub accounts
 * (their own, or a GitHub organization they own) for their own org (ownOrgId),
 * from Settings → Connections → GitHub: off to GitHub to pick the account and
 * its repositories, back through the setup route (app/api/github/app/setup),
 * which links it to their own org. Other orgs install it from
 * Settings → Org → GitHub instead.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = url.searchParams.get("next");
  const next = isInstallReturn(requested) ? requested : "/settings/connections";
  const back = (code: string) => NextResponse.redirect(appUrl(`${next}?github=${code}`, url.origin));
  const owner = await getOwner();
  if (!owner) return NextResponse.redirect(appUrl(`/signin?next=${encodeURIComponent(next)}`, url.origin));
  const config = githubAppConfig();
  if (!config) return back("not_configured");
  const orgId = await ownOrgId(owner.id).catch(() => null);
  if (!orgId) return back("failed");
  return NextResponse.redirect(installUrl(await appSlug(config), signInstallState(config.webhookSecret, { orgId, userId: owner.id, next })));
}
