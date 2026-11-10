/**
 * Where Linear's OAuth comes back to, for an org's install and for a person's link, with no
 * network. Acted on only when every part holds: the state is ours and fresh, this browser
 * started it (the nonce cookie), and the same Outrunner user is signed in. A link is made
 * only for the Linear user who just signed in.
 *
 * An install has to be the app's own token. `actor=app` is only a parameter of the link to
 * Linear, which anyone can edit, and any member of a workspace could then consent as
 * themselves: their token would replace the install's, for every org on it, acting as them.
 */

import type { TrackerTokens } from "@/lib/trackers/errors";
import type { LinearOAuthKind, LinearOAuthState, LinearViewer } from "@/lib/trackers/linear";

export type LinearCallbackInput = {
  state: LinearOAuthState | null;
  nonce: string | undefined;
  code: string | null;
  error: string | null;
};

export type LinearCallbackDeps = {
  ownerId(): Promise<string | null>;
  memberRole(orgId: string, userId: string): Promise<string | null>;
  exchange(code: string): Promise<TrackerTokens>;
  viewer(token: string): Promise<LinearViewer>;
  /** Hand a token back: what was only needed once, or never should have been made. */
  revoke(token: string): Promise<void>;
  installation(organizationId: string): Promise<{ id: string; disconnected: boolean; appUserId: string | null } | null>;
  orgUses(orgId: string, installationId: string): Promise<boolean>;
  orgIds(installationId: string): Promise<string[]>;
  saveInstall(install: { viewer: LinearViewer; tokens: TrackerTokens; ownerId: string }): Promise<string>;
  connectOrg(orgId: string, installationId: string, ownerId: string): Promise<void>;
  audit(orgId: string, viewer: LinearViewer): Promise<unknown>;
  saveLink(link: { installationId: string; viewer: LinearViewer; ownerId: string }): Promise<void>;
  /** What they were asked to link for carries on. After the answer. */
  resumeLinked(installationId: string, viewerId: string): void;
};

export type LinearCallbackResult = { result: string; kind: LinearOAuthKind | undefined };

export async function linearCallback(input: LinearCallbackInput, deps: LinearCallbackDeps): Promise<LinearCallbackResult> {
  const { state } = input;
  const done = (result: string): LinearCallbackResult => ({ result, kind: state?.kind });
  if (!state || !input.nonce || state.nonce !== input.nonce) return done("expired");
  if (input.error) return done("cancelled");
  if (!input.code) return done("expired");
  const ownerId = await deps.ownerId();
  if (!ownerId || ownerId !== state.ownerId) return done("expired");
  try {
    return done(state.kind === "install" ? await install(state, input.code, ownerId, deps) : await link(input.code, ownerId, deps));
  } catch (error) {
    console.error(`Linear ${state.kind} failed`, error);
    return done("failed");
  }
}

async function install(state: LinearOAuthState, code: string, ownerId: string, deps: LinearCallbackDeps): Promise<string> {
  const orgId = state.orgId;
  // Still their org's admin, after the trip to Linear.
  if (!orgId || (await deps.memberRole(orgId, ownerId)) !== "admin") return "not_admin";
  const tokens = await deps.exchange(code);
  const viewer = await deps.viewer(tokens.accessToken);
  if (viewer.app !== true) {
    await deps.revoke(tokens.accessToken).catch((error: unknown) => console.warn("Linear: couldn't hand back a person's token", error));
    return "not_app";
  }
  // As for Jira: every org on an install acts through its account. An app has the one user
  // in a workspace, so this is a safeguard: another only takes it from an org already on it,
  // once it's stopped working, or if no org is left.
  const existing = await deps.installation(viewer.organization.id);
  if (existing && existing.appUserId !== viewer.id) {
    const mayTake = existing.disconnected && ((await deps.orgIds(existing.id)).length === 0 || (await deps.orgUses(orgId, existing.id)));
    if (!mayTake) return "site_taken";
  }
  const installationId = await deps.saveInstall({ viewer, tokens, ownerId });
  await deps.connectOrg(orgId, installationId, ownerId);
  await deps.audit(orgId, viewer);
  return "installed";
}

async function link(code: string, ownerId: string, deps: LinearCallbackDeps): Promise<string> {
  const tokens = await deps.exchange(code);
  const viewer = await deps.viewer(tokens.accessToken);
  // It's only needed to learn who they are: not kept, and handed back.
  await deps.revoke(tokens.accessToken);
  // A link is a person's: an app token here would make the app's own events someone's.
  if (viewer.app === true) return "failed";
  const installation = await deps.installation(viewer.organization.id);
  if (!installation) return "not_installed";
  // Only someone in an org that uses this workspace has anything to link.
  const orgIds = await deps.orgIds(installation.id);
  const roles = await Promise.all(orgIds.map((orgId) => deps.memberRole(orgId, ownerId)));
  if (!roles.some(Boolean)) return "not_member";
  await deps.saveLink({ installationId: installation.id, viewer, ownerId });
  deps.resumeLinked(installation.id, viewer.id);
  return "linked";
}
