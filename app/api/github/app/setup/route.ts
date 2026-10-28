import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { ClaimError, claimInstallation, installationHolder, refreshInstallation } from "@/lib/db/github-installations";
import { memberRole } from "@/lib/db/orgs";
import { getInstallation, githubAppConfig, readInstallState, signInstallState } from "@/lib/github/app";
import { appClientSecret, authorizeUrl } from "@/lib/github/installer";
import { appUrl } from "@/lib/orgs/notify";
import { setActiveOrg } from "@/lib/orgs/server";

/** How long to wait for GitHub's webhook saying who installed it, which can
 *  land just after the admin does. */
const WAIT_FOR_WEBHOOK_MS = 8_000;

/**
 * Where GitHub sends an org's admin back after installing the App, or after
 * changing which repositories it reaches ("Redirect on update").
 *
 * - From our install link (a signed state naming the org and admin): the
 *   installation is claimed for that org, and only if the signed-in admin
 *   is the GitHub user GitHub's webhook says installed it. Installing on an
 *   organization takes one of its owners or App managers, so that is who
 *   may hand it to an org. An installation id in a link is no proof. An
 *   admin GitHub doesn't know as the installer (no GitHub account linked, or
 *   another one) is asked to sign in to GitHub for the App once, so GitHub
 *   can say who they are (app/api/github/app/verify).
 * - Without a state (an update, or an install begun on GitHub): only an
 *   installation the org has already, refreshed. Anything else is sent back
 *   to start from Outrunner's link.
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
    const stateValue = url.searchParams.get("state");
    const state = readInstallState(config.webhookSecret, stateValue);
    if (stateValue && (!state || state.userId !== owner.id)) return back("error=link_expired");

    let holder = await installationHolder(installationId);
    // No state: only one the org has, from GitHub's "Redirect on update".
    const orgId = state?.orgId ?? holder?.orgId;
    if (!orgId) return back("error=link_expired");
    if ((await memberRole(orgId, owner.id)) !== "admin") return back("error=not_admin");

    const installation = await getInstallation(config, installationId);
    if (!installation) return back("error=no_installation");

    if (holder?.orgId === orgId) {
      await refreshInstallation(orgId, installation);
      if (state?.next) {
        await setActiveOrg(orgId).catch(() => {});
        return NextResponse.redirect(appUrl(state.next, origin));
      }
      return back(`installed=${encodeURIComponent(installation.accountLogin)}`);
    }
    if (!state) return back("error=link_expired");

    // GitHub's webhook may land just after the admin does.
    for (let waited = 0; !holder && waited < WAIT_FOR_WEBHOOK_MS; waited += 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      holder = await installationHolder(installationId);
    }
    if (!holder) return back("pending=1");

    // Not the installer as far as we know: ask GitHub who they are.
    const clientSecret = appClientSecret();
    if (holder.installerId !== owner.githubId && clientSecret) {
      const verifyState = signInstallState(config.webhookSecret, { ...state, installationId });
      return NextResponse.redirect(authorizeUrl(config.clientId, appUrl("/api/github/app/verify", origin), verifyState));
    }

    await claimInstallation({ orgId, installation, githubId: owner.githubId, userId: owner.id });
    await setActiveOrg(orgId).catch(() => {});
    // Onboarding lists the App's repositories as it comes back.
    if (state.next) return NextResponse.redirect(appUrl(state.next, origin));
    return back(`installed=${encodeURIComponent(installation.accountLogin)}`);
  } catch (error) {
    if (error instanceof ClaimError) {
      const code = { taken: "taken", unknown: "no_installation", not_installer: "not_installer", removed_elsewhere: "removed_elsewhere" };
      return back(`error=${code[error.reason]}`);
    }
    console.error(`Could not keep GitHub installation ${installationId}`, error);
    return back("error=failed");
  }
}
