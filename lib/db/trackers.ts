/**
 * Issue trackers an org connects (Linear now, Jira next): installs, which org
 * owns each team, the rules that file to triage, and who's who. Service role
 * only, as the tables have no policy (20261108120000_trackers.sql); the routes
 * check who may. Tokens are sealed here and opened here.
 */

import { open, seal } from "@/lib/crypto/secret-box";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { LinearTokens } from "@/lib/trackers/linear";
import { type RuleInput, type ScopeSettings, stateMapOf, type TrackerProvider, type TrackerRule } from "@/lib/trackers/rules";
import type { TokenRow } from "@/lib/trackers/tokens";

type Tables = Database["public"]["Tables"];
type InstallationRow = Tables["tracker_installations"]["Row"];
type ScopeRow = Tables["tracker_scopes"]["Row"];
type RuleRow = Tables["tracker_rules"]["Row"];

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

function db() {
  return createSupabaseAdminClient();
}

/** An install, without its tokens. */
export type TrackerInstallation = {
  id: string;
  provider: TrackerProvider;
  externalId: string;
  siteUrl: string | null;
  name: string | null;
  appUserId: string | null;
  disconnected: boolean;
};

function toInstallation(row: InstallationRow): TrackerInstallation {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_id,
    siteUrl: row.site_url,
    name: row.name,
    appUserId: row.app_user_id,
    disconnected: row.disconnected_at !== null,
  };
}

export type TrackerScope = {
  id: string;
  installationId: string;
  orgId: string;
  externalTeamId: string;
  name: string | null;
  setBy: string | null;
  stateMap: ScopeSettings["stateMap"];
  defaultProjectId: string | null;
  acceptRuleSessions: boolean;
  ruleSessionsPerDay: number;
};

function toScope(row: ScopeRow): TrackerScope {
  return {
    id: row.id,
    installationId: row.installation_id,
    orgId: row.org_id,
    externalTeamId: row.external_team_id,
    name: row.name,
    setBy: row.set_by,
    stateMap: stateMapOf(row.state_map),
    defaultProjectId: row.default_project_id,
    acceptRuleSessions: row.accept_rule_sessions,
    ruleSessionsPerDay: row.rule_sessions_per_day,
  };
}

function toRule(row: RuleRow): TrackerRule {
  return {
    id: row.id,
    scopeId: row.scope_id,
    position: row.position,
    projectId: row.project_id,
    setBy: row.set_by,
    enabled: row.enabled,
    labels: row.labels,
    states: row.states,
    priorities: row.priorities,
    issueTypes: row.issue_types,
    assignees: row.assignees,
  };
}

// --- Installs ---------------------------------------------------------------

/**
 * Keep an install, new or again (a reconnect): it's the tracker's own consent
 * that says who may, as installing takes one of its admins. Reconnecting gives
 * it working tokens and lets rules run again.
 */
export async function saveInstallation(input: {
  provider: TrackerProvider;
  externalId: string;
  siteUrl: string | null;
  name: string | null;
  appUserId: string;
  /** Who that is, where settings have to say: Jira's account is whoever authorized. */
  appUserName?: string | null;
  tokens: LinearTokens;
  installedBy: string;
}): Promise<string> {
  const { data, error } = await db()
    .from("tracker_installations")
    .upsert(
      {
        provider: input.provider,
        external_id: input.externalId,
        site_url: input.siteUrl,
        name: input.name,
        app_user_id: input.appUserId,
        app_user_name: input.appUserName ?? null,
        access_token_ciphertext: seal(input.tokens.accessToken),
        refresh_token_ciphertext: input.tokens.refreshToken ? seal(input.tokens.refreshToken) : null,
        token_expires_at: input.tokens.expiresAt.toISOString(),
        refresh_expires_at: input.tokens.refreshExpiresAt?.toISOString() ?? null,
        refreshing_until: null,
        disconnected_at: null,
        installed_by: input.installedBy,
      },
      { onConflict: "provider,external_id" },
    )
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

/** The org uses this install from now on. */
export async function connectOrgToInstallation(orgId: string, installationId: string, connectedBy: string): Promise<void> {
  const { error } = await db()
    .from("org_tracker_installations")
    .upsert({ org_id: orgId, installation_id: installationId, connected_by: connectedBy }, { onConflict: "org_id,installation_id", ignoreDuplicates: true });
  if (error) throw error;
}

export async function installationByExternalId(provider: TrackerProvider, externalId: string): Promise<TrackerInstallation | null> {
  const { data, error } = await db()
    .from("tracker_installations")
    .select("*")
    .eq("provider", provider)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) throw error;
  return data ? toInstallation(data) : null;
}

export async function orgUsesInstallation(orgId: string, installationId: string): Promise<boolean> {
  const { data, error } = await db()
    .from("org_tracker_installations")
    .select("org_id")
    .eq("org_id", orgId)
    .eq("installation_id", installationId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/** The orgs that use an install. */
export async function installationOrgIds(installationId: string): Promise<string[]> {
  const { data, error } = await db().from("org_tracker_installations").select("org_id").eq("installation_id", installationId);
  if (error) throw error;
  return (data ?? []).map((row) => row.org_id);
}

/** The org stops using an install: its teams and rules go with it. Whether it
 *  was using it: the delete says, so there's no gap between checking and acting. */
export async function removeOrgFromInstallation(orgId: string, installationId: string): Promise<boolean> {
  const { data, error } = await db()
    .from("org_tracker_installations")
    .delete()
    .eq("org_id", orgId)
    .eq("installation_id", installationId)
    .select("org_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** What a disconnected install keeps: rules stop, and no token stays. */
const DISCONNECTED = () => ({
  disconnected_at: new Date().toISOString(),
  access_token_ciphertext: null,
  refresh_token_ciphertext: null,
  token_expires_at: null,
  refresh_expires_at: null,
  refreshing_until: null,
});

/** Revoked there, or its last org left. */
export async function markDisconnected(installationId: string): Promise<void> {
  const { error } = await db().from("tracker_installations").update(DISCONNECTED()).eq("id", installationId);
  if (error) throw error;
}

// --- Tokens (lib/trackers/tokens.ts) ----------------------------------------

function toTokenRow(row: InstallationRow): TokenRow {
  return {
    id: row.id,
    provider: row.provider,
    accessToken: row.access_token_ciphertext ? open(row.access_token_ciphertext) : null,
    refreshToken: row.refresh_token_ciphertext ? open(row.refresh_token_ciphertext) : null,
    version: row.refresh_token_ciphertext,
    expiresAt: row.token_expires_at ? Date.parse(row.token_expires_at) : null,
    disconnected: row.disconnected_at !== null,
  };
}

export async function loadTokenRow(id: string): Promise<TokenRow | null> {
  const { data, error } = await db().from("tracker_installations").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toTokenRow(data) : null;
}

/** Take the refresh lease, in one update: no one holds it, and the token is due.
 *  Null when someone does, or it isn't. */
export async function claimRefresh(id: string, opts: { now: number; leaseUntil: number; dueBefore: number }): Promise<TokenRow | null> {
  const { data, error } = await db()
    .from("tracker_installations")
    .update({ refreshing_until: new Date(opts.leaseUntil).toISOString() })
    .eq("id", id)
    .is("disconnected_at", null)
    .lt("token_expires_at", new Date(opts.dueBefore).toISOString())
    .or(`refreshing_until.is.null,refreshing_until.lt.${new Date(opts.now).toISOString()}`)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? toTokenRow(data) : null;
}

/** Keep what a refresh gave, if the row still holds the refresh token it used:
 *  someone authorizing again meanwhile replaced them, and theirs stand. */
export async function storeRefreshedTokens(id: string, tokens: LinearTokens, version: string | null): Promise<boolean> {
  const update = db()
    .from("tracker_installations")
    .update({
      access_token_ciphertext: seal(tokens.accessToken),
      // A refresh that gave none leaves the one we have.
      ...(tokens.refreshToken ? { refresh_token_ciphertext: seal(tokens.refreshToken) } : {}),
      token_expires_at: tokens.expiresAt.toISOString(),
      ...(tokens.refreshExpiresAt ? { refresh_expires_at: tokens.refreshExpiresAt.toISOString() } : {}),
      refreshing_until: null,
    })
    .eq("id", id);
  const { data, error } = await (version === null ? update.is("refresh_token_ciphertext", null) : update.eq("refresh_token_ciphertext", version)).select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Disconnect because a refresh was refused, if the row still holds the refresh
 *  token that was: one someone just saved by authorizing again isn't what was. */
export async function disconnectIfUnchanged(id: string, version: string | null): Promise<boolean> {
  const update = db().from("tracker_installations").update(DISCONNECTED()).eq("id", id);
  const { data, error } = await (version === null ? update.is("refresh_token_ciphertext", null) : update.eq("refresh_token_ciphertext", version)).select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function releaseRefresh(id: string): Promise<void> {
  const { error } = await db().from("tracker_installations").update({ refreshing_until: null }).eq("id", id);
  if (error) throw error;
}

/** A provider's installs whose token is due: what the tick refreshes. */
export async function installationsDueForRefresh(provider: TrackerProvider, dueBefore: number): Promise<string[]> {
  const { data, error } = await db()
    .from("tracker_installations")
    .select("id")
    .eq("provider", provider)
    .is("disconnected_at", null)
    .lt("token_expires_at", new Date(dueBefore).toISOString())
    .limit(200);
  if (error) throw error;
  return (data ?? []).map((row) => row.id);
}

/** The Jira site an event is about, by what its `self` URLs name: a cloud id or a host. */
export async function jiraInstallationOf(event: { cloudId: string | null; host: string | null }): Promise<TrackerInstallation | null> {
  if (event.cloudId) return installationByExternalId("jira", event.cloudId);
  if (!event.host) return null;
  const { data, error } = await db().from("tracker_installations").select("*").eq("provider", "jira").eq("site_url", `https://${event.host}`).maybeSingle();
  if (error) throw error;
  return data ? toInstallation(data) : null;
}

/** Jira sites with connected projects and no webhook: a registration that failed. */
export async function webhooksMissing(): Promise<string[]> {
  const { data, error } = await db().from("tracker_installations").select("id").eq("provider", "jira").is("disconnected_at", null).is("webhook_id", null).limit(200);
  if (error) throw error;
  return (data ?? []).map((row) => row.id);
}

/** Jira sites whose webhook is due for refreshing (they expire after 30 days). */
export async function webhooksDueForRefresh(dueBefore: number): Promise<{ id: string; webhookId: number; expiresAt: number | null }[]> {
  const { data, error } = await db()
    .from("tracker_installations")
    .select("id, webhook_id, webhook_expires_at")
    .eq("provider", "jira")
    .is("disconnected_at", null)
    .not("webhook_id", "is", null)
    .lt("webhook_expires_at", new Date(dueBefore).toISOString())
    .limit(200);
  if (error) throw error;
  return (data ?? []).map((row) => ({ id: row.id, webhookId: Number(row.webhook_id), expiresAt: row.webhook_expires_at ? Date.parse(row.webhook_expires_at) : null }));
}

export async function saveWebhook(id: string, webhookId: number | null, expiresAt: Date | null): Promise<void> {
  const { error } = await db()
    .from("tracker_installations")
    .update({ webhook_id: webhookId === null ? null : String(webhookId), webhook_expires_at: expiresAt?.toISOString() ?? null })
    .eq("id", id);
  if (error) throw error;
}

/** Every connected project of an install, whichever org's: what its webhook covers. */
export async function scopedProjects(installationId: string): Promise<string[]> {
  const { data, error } = await db().from("tracker_scopes").select("external_team_id").eq("installation_id", installationId);
  if (error) throw error;
  return (data ?? []).map((row) => row.external_team_id);
}

export async function installationById(id: string): Promise<(TrackerInstallation & { webhookId: number | null }) | null> {
  const { data, error } = await db().from("tracker_installations").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? { ...toInstallation(data), webhookId: data.webhook_id ? Number(data.webhook_id) : null } : null;
}

// --- Events -----------------------------------------------------------------

export async function trackerEventSeen(eventId: string): Promise<boolean> {
  const { data, error } = await db().from("tracker_events_seen").select("event_id").eq("event_id", eventId).maybeSingle();
  if (error) throw error;
  return data !== null;
}

/** Note an event as done. Only once it is: a crash part way leaves it for the redelivery, and
 *  two deliveries at once can both handle it, as every step can repeat. Whether this was the
 *  first to get here: what can't repeat, starting anything, goes only with that. */
export async function markTrackerEventSeen(eventId: string): Promise<boolean> {
  const { data, error } = await db().from("tracker_events_seen").upsert({ event_id: eventId }, { onConflict: "event_id", ignoreDuplicates: true }).select("event_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function pruneTrackerEvents(before: number): Promise<void> {
  const { error } = await db().from("tracker_events_seen").delete().lt("created_at", new Date(before).toISOString());
  if (error) throw error;
}

// --- Teams and rules --------------------------------------------------------

export async function scopeForTeam(installationId: string, externalTeamId: string): Promise<TrackerScope | null> {
  const { data, error } = await db()
    .from("tracker_scopes")
    .select("*")
    .eq("installation_id", installationId)
    .eq("external_team_id", externalTeamId)
    .maybeSingle();
  if (error) throw error;
  return data ? toScope(data) : null;
}

export async function rulesForScope(scopeId: string): Promise<TrackerRule[]> {
  const { data, error } = await db().from("tracker_rules").select("*").eq("scope_id", scopeId).order("position").order("created_at");
  if (error) throw error;
  return (data ?? []).map(toRule);
}

/** What a settings change can be refused for. */
export class TrackerSettingsError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

const NOT_THE_ORGS_PROJECT = "That project isn't in this org.";

/** A team becomes the org's. Only one org can have it: that's what a Linear
 *  event is routed by. */
export async function connectScope(input: {
  orgId: string;
  installationId: string;
  externalTeamId: string;
  name: string;
  setBy: string;
  stateMap: ScopeSettings["stateMap"];
}): Promise<TrackerScope> {
  const { data, error } = await db()
    .from("tracker_scopes")
    .insert({
      org_id: input.orgId,
      installation_id: input.installationId,
      external_team_id: input.externalTeamId,
      name: input.name,
      set_by: input.setBy,
      state_map: input.stateMap as Json,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) throw new TrackerSettingsError("That team is already connected to an org.", 409);
    if (error.code === FOREIGN_KEY_VIOLATION) throw new TrackerSettingsError("This org isn't connected to that workspace.", 404);
    throw error;
  }
  return toScope(data);
}

export async function orgScope(orgId: string, scopeId: string): Promise<(TrackerScope & { provider: TrackerProvider }) | null> {
  const { data, error } = await db().from("tracker_scopes").select("*").eq("org_id", orgId).eq("id", scopeId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: install, error: installError } = await db()
    .from("tracker_installations")
    .select("provider")
    .eq("id", data.installation_id)
    .single();
  if (installError) throw installError;
  return { ...toScope(data), provider: install.provider };
}

export async function updateScope(orgId: string, scopeId: string, patch: Partial<ScopeSettings>): Promise<TrackerScope | null> {
  const { data, error } = await db()
    .from("tracker_scopes")
    .update({
      ...(patch.defaultProjectId !== undefined && { default_project_id: patch.defaultProjectId }),
      ...(patch.acceptRuleSessions !== undefined && { accept_rule_sessions: patch.acceptRuleSessions }),
      ...(patch.ruleSessionsPerDay !== undefined && { rule_sessions_per_day: patch.ruleSessionsPerDay }),
      ...(patch.stateMap !== undefined && { state_map: patch.stateMap as Json }),
    })
    .eq("org_id", orgId)
    .eq("id", scopeId)
    .select("*")
    .maybeSingle();
  if (error) {
    // (org_id, default_project_id) → projects: another org's project is refused.
    if (error.code === FOREIGN_KEY_VIOLATION) throw new TrackerSettingsError(NOT_THE_ORGS_PROJECT);
    throw error;
  }
  return data ? toScope(data) : null;
}

export async function deleteScope(orgId: string, scopeId: string): Promise<boolean> {
  const { data, error } = await db().from("tracker_scopes").delete().eq("org_id", orgId).eq("id", scopeId).select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** A new rule, last in its team's order. Its set_by is who filing falls back to. */
export async function createRule(orgId: string, scopeId: string, input: RuleInput, setBy: string): Promise<TrackerRule> {
  const { data: last, error: lastError } = await db()
    .from("tracker_rules")
    .select("position")
    .eq("scope_id", scopeId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) throw lastError;
  const { data, error } = await db()
    .from("tracker_rules")
    .insert({
      org_id: orgId,
      scope_id: scopeId,
      position: (last?.position ?? -1) + 1,
      project_id: input.projectId,
      labels: input.labels,
      states: input.states,
      priorities: input.priorities,
      issue_types: input.issueTypes,
      assignees: input.assignees,
      enabled: input.enabled,
      set_by: setBy,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === FOREIGN_KEY_VIOLATION) throw new TrackerSettingsError(NOT_THE_ORGS_PROJECT);
    throw error;
  }
  return toRule(data);
}

export async function orgRule(orgId: string, ruleId: string): Promise<TrackerRule | null> {
  const { data, error } = await db().from("tracker_rules").select("*").eq("org_id", orgId).eq("id", ruleId).maybeSingle();
  if (error) throw error;
  return data ? toRule(data) : null;
}

/** Change a rule. Whoever changes what it files takes it on, as an automation's
 *  runner does; switching it off and on again leaves it with its setter. */
export async function updateRule(orgId: string, ruleId: string, patch: Partial<RuleInput>, changedBy: string): Promise<TrackerRule | null> {
  const { data, error } = await db()
    .from("tracker_rules")
    .update({
      ...(patch.projectId !== undefined && { project_id: patch.projectId }),
      ...(patch.labels !== undefined && { labels: patch.labels }),
      ...(patch.states !== undefined && { states: patch.states }),
      ...(patch.priorities !== undefined && { priorities: patch.priorities }),
      ...(patch.issueTypes !== undefined && { issue_types: patch.issueTypes }),
      ...(patch.assignees !== undefined && { assignees: patch.assignees }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      ...(Object.keys(patch).some((field) => field !== "enabled") && { set_by: changedBy }),
    })
    .eq("org_id", orgId)
    .eq("id", ruleId)
    .select("*")
    .maybeSingle();
  if (error) {
    if (error.code === FOREIGN_KEY_VIOLATION) throw new TrackerSettingsError(NOT_THE_ORGS_PROJECT);
    throw error;
  }
  return data ? toRule(data) : null;
}

/** Swap a rule with its neighbour in its team's order. */
export async function moveRule(orgId: string, ruleId: string, direction: "up" | "down"): Promise<boolean> {
  const rule = await orgRule(orgId, ruleId);
  if (!rule) return false;
  const rules = await rulesForScope(rule.scopeId);
  const at = rules.findIndex((r) => r.id === ruleId);
  const other = rules[direction === "up" ? at - 1 : at + 1];
  if (!other) return true;
  // Renumbered, so rules that happen to share a position still swap.
  const order = rules.map((r) => r.id);
  order[at] = other.id;
  order[rules.indexOf(other)] = ruleId;
  const client = db();
  const results = await Promise.all(order.map((id, position) => client.from("tracker_rules").update({ position }).eq("id", id)));
  const failed = results.find((r) => r.error);
  if (failed?.error) throw failed.error;
  return true;
}

export async function deleteRule(orgId: string, ruleId: string): Promise<boolean> {
  const { data, error } = await db().from("tracker_rules").delete().eq("org_id", orgId).eq("id", ruleId).select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

// --- People -----------------------------------------------------------------

/** The Outrunner user a tracker user is, or null. */
export async function linkedOwner(installationId: string, externalUserId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("tracker_links")
    .select("owner_id")
    .eq("installation_id", installationId)
    .eq("external_user_id", externalUserId)
    .maybeSingle();
  if (error) throw error;
  return data?.owner_id ?? null;
}

/** Link a tracker user to the owner, who just signed in there as them; a link
 *  that tracker user had moves. */
export async function saveTrackerLink(input: { installationId: string; externalUserId: string; externalName: string | null; ownerId: string }): Promise<void> {
  const { error } = await db().from("tracker_links").upsert(
    {
      installation_id: input.installationId,
      external_user_id: input.externalUserId,
      external_name: input.externalName,
      owner_id: input.ownerId,
    },
    { onConflict: "installation_id,external_user_id" },
  );
  if (error) throw error;
}

export type TrackerLink = {
  installationId: string;
  provider: TrackerProvider;
  workspace: string | null;
  externalUserId: string;
  externalName: string | null;
};

export async function listTrackerLinks(ownerId: string): Promise<TrackerLink[]> {
  const client = db();
  const { data, error } = await client.from("tracker_links").select("*").eq("owner_id", ownerId).order("created_at");
  if (error) throw error;
  if (!data.length) return [];
  const { data: installs, error: installsError } = await client
    .from("tracker_installations")
    .select("id, provider, name")
    .in("id", [...new Set(data.map((row) => row.installation_id))]);
  if (installsError) throw installsError;
  const byId = new Map((installs ?? []).map((i) => [i.id, i]));
  return data.flatMap((row) => {
    const install = byId.get(row.installation_id);
    if (!install) return [];
    return [
      {
        installationId: row.installation_id,
        provider: install.provider,
        workspace: install.name,
        externalUserId: row.external_user_id,
        externalName: row.external_name,
      },
    ];
  });
}

/** Unlink one of the owner's own. */
export async function deleteTrackerLink(ownerId: string, installationId: string, externalUserId: string): Promise<void> {
  const { error } = await db()
    .from("tracker_links")
    .delete()
    .eq("owner_id", ownerId)
    .eq("installation_id", installationId)
    .eq("external_user_id", externalUserId);
  if (error) throw error;
}

// --- The settings page ------------------------------------------------------

export type OrgTracker = TrackerInstallation & {
  /** Who it acts as, where that's known. */
  connectedAs: string | null;
  webhookId: string | null;
  webhookExpiresAt: string | null;
  scopes: (TrackerScope & { rules: TrackerRule[] })[];
};

/** What the org has connected of a tracker: installs, their teams, each team's
 *  rules. No tokens. */
export async function orgTrackers(orgId: string, provider: TrackerProvider): Promise<OrgTracker[]> {
  const client = db();
  const { data: links, error: linksError } = await client.from("org_tracker_installations").select("installation_id").eq("org_id", orgId);
  if (linksError) throw linksError;
  const ids = (links ?? []).map((l) => l.installation_id);
  if (ids.length === 0) return [];
  const [installs, scopes, rules] = await Promise.all([
    client.from("tracker_installations").select("*").in("id", ids).eq("provider", provider).order("created_at"),
    client.from("tracker_scopes").select("*").eq("org_id", orgId).order("created_at"),
    client.from("tracker_rules").select("*").eq("org_id", orgId).order("position").order("created_at"),
  ]);
  if (installs.error) throw installs.error;
  if (scopes.error) throw scopes.error;
  if (rules.error) throw rules.error;
  return (installs.data ?? []).map((install) => ({
    ...toInstallation(install),
    connectedAs: install.app_user_name,
    webhookId: install.webhook_id,
    webhookExpiresAt: install.webhook_expires_at,
    scopes: (scopes.data ?? [])
      .filter((s) => s.installation_id === install.id)
      .map((s) => ({ ...toScope(s), rules: (rules.data ?? []).filter((r) => r.scope_id === s.id).map(toRule) })),
  }));
}
