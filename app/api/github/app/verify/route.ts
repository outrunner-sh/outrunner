import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { ClaimError, claimInstallation } from "@/lib/db/github-installations";
import { memberRole } from "@/lib/db/orgs";
import { getInstallation, githubAppConfig, readInstallState } from "@/lib/github/app";
import { appClientSecret, githubUserFromCode } from "@/lib/github/installer";
import { appUrl } from "@/lib/orgs/notify";
import { setActiveOrg } from "@/lib/orgs/server";

/**
 * Back from signing in to GitHub for the App (lib/github/installer.ts), on
 * the way from installing it (app/api/github/app/setup): the GitHub user the
 * code signs in is who claims the installation for the org, so it's the
 * org's only if that's who installed it. The state, signed, names the org,
 * the admin and the installation.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;
  const back = (query: string) => NextResponse.redirect(appUrl(`/settings/org/github?${query}`, origin));

  const owner = await getOwner();
  if (!owner) return NextResponse.redirect(appUrl(`/signin?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`, origin));
  const config = githubAppConfig();
  const clientSecret = appClientSecret();
  if (!config || !clientSecret) return back("error=not_configured");

  const state = readInstallState(config.webhookSecret, url.searchParams.get("state"));
  const code = url.searchParams.get("code");
  if (!state || state.userId !== owner.id || !state.installationId) return back("error=link_expired");
  // Cancelled on GitHub.
  if (!code) return back("error=verify_declined");

  try {
    if ((await memberRole(state.orgId, owner.id)) !== "admin") return back("error=not_admin");
    const githubId = await githubUserFromCode(config, clientSecret, code, appUrl("/api/github/app/verify", origin));
    if (!githubId) return back("error=verify_declined");
    const installation = await getInstallation(config, state.installationId);
    if (!installation) return back("error=no_installation");
    await claimInstallation({ orgId: state.orgId, installation, githubId, userId: owner.id });
    await setActiveOrg(state.orgId).catch(() => {});
    if (state.next) return NextResponse.redirect(appUrl(state.next, origin));
    return back(`installed=${encodeURIComponent(installation.accountLogin)}`);
  } catch (error) {
    if (error instanceof ClaimError) {
      const codes = { taken: "taken", unknown: "no_installation", not_installer: "not_installer", removed_elsewhere: "removed_elsewhere" };
      return back(`error=${codes[error.reason]}`);
    }
    console.error(`Could not keep GitHub installation ${state.installationId}`, error);
    return back("error=failed");
  }
}
