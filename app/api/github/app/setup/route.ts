import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { InstallationTakenError, installationOrg, keepInstallation } from "@/lib/db/github-installations";
import { memberRole } from "@/lib/db/orgs";
import { getInstallation, githubAppConfig, readInstallState, userCanReachInstallation } from "@/lib/github/app";
import { requireGithubToken } from "@/lib/github/token";
import { appUrl } from "@/lib/orgs/notify";
import { getOrgContext, setActiveOrg } from "@/lib/orgs/server";

/**
 * Where GitHub sends an org's admin back after installing the App, or after
 * changing which repositories it reaches ("Redirect on update"). Keeps the
 * installation for the org the install link named (its signed state), or
 * for the org that has it already (an update), or, coming from GitHub with
 * no state, for the org the admin is looking at.
 *
 * Only after asking GitHub, with the admin's own sign-in, that the
 * installation is one they can reach: an installation id in a link is no
 * proof of anything.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;
  const back = (query: string) => NextResponse.redirect(appUrl(`/settings/org/github?${query}`, origin));

  const owner = await getOwner();
  if (!owner) return NextResponse.redirect(appUrl(`/signin?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`, origin));
  const config = githubAppConfig();
  if (!config) return back("error=not_configured");

  const installationId = Number(url.searchParams.get("installation_id"));
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return back("error=no_installation");

  try {
    const state = readInstallState(config.webhookSecret, url.searchParams.get("state"));
    if (url.searchParams.get("state") && (!state || state.userId !== owner.id)) return back("error=link_expired");
    const orgId =
      state?.orgId ?? (await installationOrg(installationId)) ?? (await getOrgContext().catch(() => null))?.active.id;
    if (!orgId || (await memberRole(orgId, owner.id)) !== "admin") return back("error=not_admin");

    if (!(await userCanReachInstallation(await requireGithubToken(owner.id), installationId))) {
      return back("error=not_yours");
    }
    const installation = await getInstallation(config, installationId);
    if (!installation) return back("error=no_installation");
    await keepInstallation(orgId, installation, owner.id);
    await setActiveOrg(orgId).catch(() => {});
    return back(`installed=${encodeURIComponent(installation.accountLogin)}`);
  } catch (error) {
    if (error instanceof InstallationTakenError) return back("error=taken");
    console.error(`Could not keep GitHub installation ${installationId}`, error);
    return back("error=failed");
  }
}
