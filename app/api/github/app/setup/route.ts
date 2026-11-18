import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { getOwner } from "@/lib/auth/owner";
import { getGithubConnection } from "@/lib/db/github-connections";
import { ClaimError, claimInstallation, installationHolder, refreshInstallation } from "@/lib/db/github-installations";
import { memberRole, personalOrgId } from "@/lib/db/orgs";
import { getInstallation, githubAppConfig, readInstallState, signInstallState } from "@/lib/github/app";
import { returnWithoutState } from "@/lib/github/connect-installation";
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
 * - From our signed install link: connecting needs the GitHub installer
 *   named by the webhook, or an owner of the GitHub account or organization
 *   it's installed on (lib/github/installation-owner.ts), as one of the
 *   admin's GitHub accounts: their sign-in, or the one they connected for
 *   repositories (Settings → Connections, which GitHub vouched for). When
 *   neither is, ask them to authorize the App once on GitHub
 *   (app/api/github/app/verify). Administering another org that uses it, or
 *   an installation id alone, grants no access.
 * - Without a state (an update, or an install begun on GitHub): an
 *   installation the org has already (the active one, or their personal
 *   org) is refreshed. One the active org hasn't, which they administer, is
 *   offered on its GitHub settings for them to add with a click, which checks
 *   GitHub's say as above; nothing is linked on this GET alone
 *   (lib/github/connect-installation.ts).
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
    // No state: one the org has, from GitHub's "Redirect on update", or one
    // to offer the org they're looking at.
    let orgId = state?.orgId ?? null;
    let personal: string | null = null;
    if (!state) {
      personal = await personalOrgId(owner.id).catch(() => null);
      const next = returnWithoutState({
        linkedOrgIds: holder?.orgIds ?? null,
        activeOrg: (await getOrgContext())?.active ?? null,
        personalOrgId: personal,
      });
      if (next.kind === "expired") return back("error=link_expired");
      if (next.kind === "not_admin") return back("error=not_admin");
      if (next.kind === "offer") return back(`connect=${installationId}`);
      orgId = next.orgId;
    }
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
    const githubIds = [owner.githubId, connected && !connected.broken ? connected.githubUserId : null];
    try {
      await claimInstallation({ orgId, installation, githubIds, userId: owner.id });
    } catch (error) {
      // Neither GitHub account we know is theirs is its installer or an
      // owner of its account: ask GitHub who they are, once.
      const clientSecret = appClientSecret();
      if (error instanceof ClaimError && error.reason === "not_installer" && clientSecret) {
        const verifyState = signInstallState(config.webhookSecret, { ...state, installationId });
        return NextResponse.redirect(authorizeUrl(config.clientId, appUrl("/api/github/app/verify", origin), verifyState));
      }
      throw error;
    }
    await recordAudit({
      orgId,
      actor: owner,
      action: "github.installed",
      resource: { type: "installation", id: String(installation.id), label: installation.accountLogin },
    });
    // Their own connection's page leaves the org they're looking at as it is.
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
