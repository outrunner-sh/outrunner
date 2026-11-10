import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { getOwner } from "@/lib/auth/owner";
import { getGithubConnection } from "@/lib/db/github-connections";
import { ClaimError, claimInstallation, installationHolder, refreshInstallation } from "@/lib/db/github-installations";
import { memberRole, personalOrgId } from "@/lib/db/orgs";
import { getInstallation, githubAppConfig, readInstallState, signInstallState } from "@/lib/github/app";
import { appClientSecret, authorizeUrl } from "@/lib/github/installer";
import { appUrl } from "@/lib/orgs/notify";
import { getOrgContext, setActiveOrg } from "@/lib/orgs/server";

/** How long to wait for GitHub's webhook saying who installed it, which can
 *  land just after the admin does. */
const WAIT_FOR_WEBHOOK_MS = 8_000;

/**
 * Where GitHub sends an org's admin back after installing the App, or after
 * changing which repositories it reaches ("Redirect on update").
 *
 * - From our signed install link: the admin can connect an installation
 *   already used by another org they administer. A first connection needs
 *   the GitHub installer named by the webhook: the admin's GitHub sign-in, or
 *   the GitHub account they connected for repositories (Settings →
 *   Connections, which GitHub vouched for). When neither is, ask them to
 *   authorize the App once on GitHub (app/api/github/app/verify). An
 *   installation id alone grants no access.
 * - Without a state (an update, or an install begun on GitHub): only an
 *   installation the org has already (the active one, or their personal
 *   org), refreshed. Anything else is sent back to start from Outrunner's link.
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
    const activeOrg = state ? null : (await getOrgContext())?.active;
    const personal = state ? null : await personalOrgId(owner.id).catch(() => null);
    const orgId =
      state?.orgId ??
      (activeOrg && holder?.orgIds.includes(activeOrg.id)
        ? activeOrg.id
        : personal && holder?.orgIds.includes(personal)
          ? personal
          : null);
    if (!orgId) return back("error=link_expired");
    // Their own connection's page, for their personal org's installations.
    const done = (login: string) =>
      state?.next
        ? NextResponse.redirect(appUrl(state.next, origin))
        : orgId === personal
          ? NextResponse.redirect(appUrl("/settings/connections?github=updated", origin))
          : back(`installed=${encodeURIComponent(login)}`);
    if ((await memberRole(orgId, owner.id)) !== "admin") return back("error=not_admin");

    const installation = await getInstallation(config, installationId);
    if (!installation) return back("error=no_installation");

    if (holder?.orgIds.includes(orgId)) {
      await refreshInstallation(orgId, installation);
      if (state?.next === "/onboarding") await setActiveOrg(orgId).catch(() => {});
      return done(installation.accountLogin);
    }
    if (!state) return back("error=link_expired");

    // GitHub's webhook may land just after the admin does.
    for (let waited = 0; !holder && waited < WAIT_FOR_WEBHOOK_MS; waited += 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      holder = await installationHolder(installationId);
    }
    if (!holder) return back("pending=1");

    // The GitHub accounts GitHub has vouched are theirs: their sign-in's, and
    // the one they connected for repositories.
    const connected = await getGithubConnection(owner.id).catch(() => null);
    const githubId =
      [owner.githubId, connected && !connected.broken ? connected.githubUserId : null].find(
        (id) => id !== null && id === holder?.installerId,
      ) ?? owner.githubId;
    // A first connection by another identity: ask GitHub who they are.
    const clientSecret = appClientSecret();
    if (holder.orgIds.length === 0 && holder.installerId !== githubId && clientSecret) {
      const verifyState = signInstallState(config.webhookSecret, { ...state, installationId });
      return NextResponse.redirect(authorizeUrl(config.clientId, appUrl("/api/github/app/verify", origin), verifyState));
    }

    await claimInstallation({ orgId, installation, githubId, userId: owner.id });
    await recordAudit({
      orgId,
      actor: owner,
      action: "github.installed",
      resource: { type: "installation", id: String(installation.id), label: installation.accountLogin },
    });
    // Onboarding lists the App's repositories as it comes back; their own
    // connection's page leaves the org they're looking at as it is.
    if (state.next !== "/settings/connections") await setActiveOrg(orgId).catch(() => {});
    return done(installation.accountLogin);
  } catch (error) {
    if (error instanceof ClaimError) {
      const code = { unknown: "no_installation", not_installer: "not_installer", not_admin: "not_admin" };
      return back(`error=${code[error.reason]}`);
    }
    console.error(`Could not keep GitHub installation ${installationId}`, error);
    return back("error=failed");
  }
}
