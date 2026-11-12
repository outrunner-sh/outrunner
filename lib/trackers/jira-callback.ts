/**
 * Where Atlassian's OAuth comes back to, for an org's install and for a person's link, with
 * no network. Acted on only when every part holds: the state is ours and fresh, this browser
 * started it (the nonce cookie), and the same Outrunner user is signed in. A link is made
 * only for the Jira user who just signed in.
 *
 * Anyone on a site can connect it first, and then nobody else can. So its Jira admin, signed
 * in as themselves, can clear it: whoever holds it is disconnected, and every org comes off
 * it. Jira says who's an admin, and the service account needs no privilege for that. Their
 * token isn't kept, and nothing is connected: the org then connects as usual.
 */

import type { TrackerTokens } from "@/lib/trackers/errors";
import type { JiraOAuthKind, JiraOAuthState, JiraSite } from "@/lib/trackers/jira";

export type JiraCallbackInput = {
  state: JiraOAuthState | null;
  nonce: string | undefined;
  code: string | null;
  error: string | null;
};

export type JiraCallbackDeps = {
  ownerId(): Promise<string | null>;
  memberRole(orgId: string, userId: string): Promise<string | null>;
  exchange(code: string): Promise<TrackerTokens>;
  sites(token: string): Promise<JiraSite[]>;
  me(token: string): Promise<{ accountId: string; name: string | null } | null>;
  installation(siteId: string): Promise<{ id: string; disconnected: boolean; appUserId: string | null } | null>;
  orgUses(orgId: string, installationId: string): Promise<boolean>;
  orgIds(installationId: string): Promise<string[]>;
  saveInstall(install: { site: JiraSite; me: { accountId: string; name: string | null }; tokens: TrackerTokens; ownerId: string }): Promise<string>;
  connectOrg(orgId: string, installationId: string, ownerId: string): Promise<void>;
  audit(orgId: string, site: JiraSite): Promise<unknown>;
  syncWebhook(installationId: string): Promise<void>;
  /** Whether this token's person administers the site. */
  isSiteAdmin(token: string, siteId: string): Promise<boolean>;
  /** Disconnect whoever holds it, and take every org off it. */
  evict(installationId: string, by: { orgId: string; ownerId: string }): Promise<void>;
  saveLink(link: { installationId: string; accountId: string; name: string | null; ownerId: string }): Promise<void>;
  /** What they were asked to link for carries on. After the answer. */
  resumeLinked(installationId: string, accountId: string): void;
};

export type JiraCallbackResult = {
  result: string;
  kind: JiraOAuthKind | undefined;
  /** The site refused: what a reclaim would be for. */
  siteId?: string;
};

export async function jiraCallback(input: JiraCallbackInput, deps: JiraCallbackDeps): Promise<JiraCallbackResult> {
  const { state } = input;
  const done = (result: string): JiraCallbackResult => ({ result, kind: state?.kind });
  if (!state || !input.nonce || state.nonce !== input.nonce) return done("expired");
  if (input.error) return done("cancelled");
  if (!input.code) return done("expired");
  const ownerId = await deps.ownerId();
  if (!ownerId || ownerId !== state.ownerId) return done("expired");
  try {
    if (state.kind === "reclaim") return done(await reclaim(state, input.code, ownerId, deps));
    if (state.kind === "link") return done(await link(input.code, ownerId, deps));
    const installed = await install(state, input.code, ownerId, deps);
    return typeof installed === "string" ? done(installed) : { ...done("site_taken"), siteId: installed.takenSite };
  } catch (error) {
    console.error(`Jira ${state.kind} failed`, error);
    return done("failed");
  }
}

/** Nothing changes unless Jira says this person administers the site, on their own token. */
async function reclaim(state: JiraOAuthState, code: string, ownerId: string, deps: JiraCallbackDeps): Promise<string> {
  const { orgId, siteId } = state;
  if (!orgId || !siteId || (await deps.memberRole(orgId, ownerId)) !== "admin") return "not_admin";
  const tokens = await deps.exchange(code);
  const sites = await deps.sites(tokens.accessToken);
  // Their grant has to reach this site: a permission on another proves nothing.
  if (!sites.some((site) => site.id === siteId)) return "not_site_admin";
  if (!(await deps.isSiteAdmin(tokens.accessToken, siteId))) return "not_site_admin";
  const existing = await deps.installation(siteId);
  if (existing) await deps.evict(existing.id, { orgId, ownerId });
  return "reclaimed";
}

async function install(state: JiraOAuthState, code: string, ownerId: string, deps: JiraCallbackDeps): Promise<string | { takenSite: string }> {
  const orgId = state.orgId;
  // Still their org's admin, after the trip to Atlassian.
  if (!orgId || (await deps.memberRole(orgId, ownerId)) !== "admin") return "not_admin";
  const tokens = await deps.exchange(code);
  const [sites, me] = await Promise.all([deps.sites(tokens.accessToken), deps.me(tokens.accessToken)]);
  if (!me || sites.length === 0) return "failed";
  // One grant, one refresh token, however many sites it reaches, and each refresh replaces
  // it. So a token can't be kept per site: the install is one site's account.
  const site = sites[0];
  if (sites.length > 1 || !site) return "many_sites";

  // Anyone on a site can authorize a 3LO app, not only its admins, and every org that uses
  // an install reads and writes through its account. So another account takes it only once
  // it's stopped working, and then only from an org already on it, or if no org is left. A
  // refused refresh disconnects too, with other orgs still linked: being disconnected isn't
  // enough. The last org leaving has to free it, or nothing could ever connect that site.
  const existing = await deps.installation(site.id);
  if (existing && existing.appUserId !== me.accountId) {
    const mayTake = existing.disconnected && ((await deps.orgIds(existing.id)).length === 0 || (await deps.orgUses(orgId, existing.id)));
    if (!mayTake) return { takenSite: site.id };
  }
  const installationId = await deps.saveInstall({ site, me, tokens, ownerId });
  await deps.connectOrg(orgId, installationId, ownerId);
  await deps.audit(orgId, site);
  // A reconnect's projects are still connected, and its old webhook may be gone.
  await deps.syncWebhook(installationId);
  return "installed";
}

async function link(code: string, ownerId: string, deps: JiraCallbackDeps): Promise<string> {
  const tokens = await deps.exchange(code);
  const [sites, me] = await Promise.all([deps.sites(tokens.accessToken), deps.me(tokens.accessToken)]);
  // It's only needed to learn who they are: not kept. Atlassian has no call to hand it back.
  if (!me) return "failed";
  let installed = false;
  let linked = false;
  for (const site of sites) {
    const installation = await deps.installation(site.id);
    if (!installation) continue;
    installed = true;
    // Only someone in an org that uses this site has anything to link.
    const orgIds = await deps.orgIds(installation.id);
    const roles = await Promise.all(orgIds.map((orgId) => deps.memberRole(orgId, ownerId)));
    if (!roles.some(Boolean)) continue;
    await deps.saveLink({ installationId: installation.id, accountId: me.accountId, name: me.name, ownerId });
    deps.resumeLinked(installation.id, me.accountId);
    linked = true;
  }
  return linked ? "linked" : installed ? "not_member" : "not_installed";
}
