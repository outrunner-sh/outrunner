import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { appSlug, githubAppConfig, installUrl, signInstallState } from "@/lib/github/app";
import { appUrl } from "@/lib/orgs/notify";
import { getOrgContext } from "@/lib/orgs/server";

/**
 * Install the Outrunner GitHub App for the org the app is showing: off to
 * GitHub to pick an account and its repositories, carrying a signed state
 * that names the org and its admin, which the setup route
 * (app/api/github/app/setup) checks on the way back. The org's admins only.
 */
export async function GET(request: Request) {
  const back = (code: string) => NextResponse.redirect(appUrl(`/settings/org/github?error=${code}`, new URL(request.url).origin));
  const owner = await getOwner();
  if (!owner) return NextResponse.redirect(appUrl("/signin?next=/settings/org/github", new URL(request.url).origin));
  const config = githubAppConfig();
  if (!config) return back("not_configured");
  const context = await getOrgContext().catch(() => null);
  if (!context || context.active.role !== "admin") return back("not_admin");
  return NextResponse.redirect(
    installUrl(await appSlug(config), signInstallState(config.webhookSecret, { orgId: context.active.id, userId: owner.id })),
  );
}
