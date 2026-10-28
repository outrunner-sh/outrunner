/**
 * Webhooks' records (api_webhook_settings, api_watches,
 * api_webhook_deliveries; supabase/migrations/20261102130000_api_webhooks.sql):
 * service role only. Secrets are sealed at rest.
 */

import { newWebhookSecret, type WatchState, type WebhookEvent } from "@/lib/api/webhooks";
import { open, seal } from "@/lib/crypto/secret-box";
import type { Json } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** Whose secret and endpoint: an org's (its org keys) or a user's (their
 *  personal keys and CLI). */
export type WebhookScope = { scope: "org" | "user"; scopeId: string };

function db() {
  return createSupabaseAdminClient();
}

/** The scope's endpoint and secret, its secret made the first time it's
 *  asked for. */
export async function webhookSettings(who: WebhookScope): Promise<{ url: string | null; secret: string }> {
  const { data, error } = await db()
    .from("api_webhook_settings")
    .select("url, secret_ciphertext")
    .eq("scope", who.scope)
    .eq("scope_id", who.scopeId)
    .maybeSingle();
  if (error) throw error;
  if (data) return { url: data.url, secret: open(data.secret_ciphertext) };
  // Two at once: the first one's secret is kept, and both read it back.
  const { error: insertError } = await db()
    .from("api_webhook_settings")
    .upsert(
      { scope: who.scope, scope_id: who.scopeId, secret_ciphertext: seal(newWebhookSecret()) },
      { onConflict: "scope,scope_id", ignoreDuplicates: true },
    );
  if (insertError) throw insertError;
  return webhookSettings(who);
}

/** Set (or, with null, clear) the scope's own endpoint. */
export async function setWebhookEndpoint(who: WebhookScope, url: string | null, by: string): Promise<void> {
  await webhookSettings(who);
  const { error } = await db()
    .from("api_webhook_settings")
    .update({ url, updated_by: by, updated_at: new Date().toISOString() })
    .eq("scope", who.scope)
    .eq("scope_id", who.scopeId);
  if (error) throw error;
}

/** Replace the scope's secret: deliveries from now on are signed with the new one. */
export async function rotateWebhookSecret(who: WebhookScope, by: string): Promise<void> {
  await webhookSettings(who);
  const { error } = await db()
    .from("api_webhook_settings")
    .update({ secret_ciphertext: seal(newWebhookSecret()), updated_by: by, updated_at: new Date().toISOString() })
    .eq("scope", who.scope)
    .eq("scope_id", who.scopeId);
  if (error) throw error;
}

export type Watch = WatchState &
  WebhookScope & {
    workspaceId: string;
    orgId: string;
    userId: string;
    webhookUrl: string | null;
    toldPrs: string[];
    watchUntil: string | null;
  };

type WatchRow = {
  workspace_id: string;
  org_id: string;
  user_id: string;
  scope: "org" | "user";
  scope_id: string;
  webhook_url: string | null;
  awaiting: boolean;
  seen_working: boolean;
  baseline_event: string | null;
  asked_tool_use: string | null;
  told_prs: string[];
  watch_until: string | null;
};

function toWatch(row: WatchRow): Watch {
  return {
    workspaceId: row.workspace_id,
    orgId: row.org_id,
    userId: row.user_id,
    scope: row.scope,
    scopeId: row.scope_id,
    webhookUrl: row.webhook_url,
    awaiting: row.awaiting,
    seenWorking: row.seen_working,
    baselineEvent: row.baseline_event,
    askedToolUse: row.asked_tool_use,
    toldPrs: row.told_prs,
    watchUntil: row.watch_until,
  };
}

const WATCH_COLUMNS =
  "workspace_id, org_id, user_id, scope, scope_id, webhook_url, awaiting, seen_working, baseline_event, asked_tool_use, told_prs, watch_until";

/** Watch a session made through the API. */
export async function createWatch(input: {
  workspaceId: string;
  orgId: string;
  userId: string;
  who: WebhookScope;
  webhookUrl: string | null;
}): Promise<void> {
  const { error } = await db().from("api_watches").insert({
    workspace_id: input.workspaceId,
    org_id: input.orgId,
    user_id: input.userId,
    scope: input.who.scope,
    scope_id: input.who.scopeId,
    webhook_url: input.webhookUrl,
  });
  if (error) throw error;
}

export async function getWatch(workspaceId: string): Promise<Watch | null> {
  const { data, error } = await db().from("api_watches").select(WATCH_COLUMNS).eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw error;
  return data ? toWatch(data) : null;
}

/** A turn's end is now awaited (a message was sent), for `forMs`. */
export async function awaitTurn(workspaceId: string, forMs: number): Promise<void> {
  const { error } = await db()
    .from("api_watches")
    .update({
      awaiting: true,
      seen_working: false,
      baseline_event: null,
      asked_tool_use: null,
      watch_until: new Date(Date.now() + forMs).toISOString(),
    })
    .eq("workspace_id", workspaceId);
  if (error) throw error;
}

/**
 * Move a watch on from `from` to `next`, if no one else has since: so of a
 * watch and the tick looking at once, only one tells what they saw. False
 * when the other got there first.
 */
export async function advanceWatch(
  workspaceId: string,
  from: WatchState,
  next: WatchState & { toldPrs?: string[]; watchUntil?: string | null },
): Promise<boolean> {
  let query = db()
    .from("api_watches")
    .update({
      awaiting: next.awaiting,
      seen_working: next.seenWorking,
      baseline_event: next.baselineEvent,
      asked_tool_use: next.askedToolUse,
      checked_at: new Date().toISOString(),
      ...(next.toldPrs && { told_prs: next.toldPrs }),
      ...(next.watchUntil !== undefined && { watch_until: next.watchUntil }),
    })
    .eq("workspace_id", workspaceId)
    .eq("awaiting", from.awaiting)
    .eq("seen_working", from.seenWorking);
  query = from.baselineEvent === null ? query.is("baseline_event", null) : query.eq("baseline_event", from.baselineEvent);
  query = from.askedToolUse === null ? query.is("asked_tool_use", null) : query.eq("asked_tool_use", from.askedToolUse);
  const { data, error } = await query.select("workspace_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Stop watching: nothing left to tell. True for the one call that ended
 *  it, so of two looks at once only one tells why. */
export async function endWatch(workspaceId: string): Promise<boolean> {
  const { data, error } = await db()
    .from("api_watches")
    .update({ awaiting: false, watch_until: null, checked_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .not("watch_until", "is", null)
    .select("workspace_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Watches still awaiting something that no one has looked at for a minute:
 *  the tick's. */
export async function dueWatches(limit = 50): Promise<Watch[]> {
  const now = new Date();
  const { data, error } = await db()
    .from("api_watches")
    .select(WATCH_COLUMNS)
    .gt("watch_until", now.toISOString())
    .or(`checked_at.is.null,checked_at.lt.${new Date(now.getTime() - 60_000).toISOString()}`)
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(toWatch);
}

/** Watches past their time: let go. */
export async function expireWatches(): Promise<void> {
  const { error } = await db().from("api_watches").update({ watch_until: null, awaiting: false }).lt("watch_until", new Date().toISOString());
  if (error) throw error;
}

export type Delivery = {
  id: string;
  url: string;
  event: WebhookEvent;
  payload: Json;
  attempts: number;
} & WebhookScope;

/** Queue an event for each URL; the ids, to try at once. */
export async function enqueueDeliveries(
  who: WebhookScope,
  workspaceId: string | null,
  event: WebhookEvent,
  urls: readonly string[],
  payloadFor: (id: string) => Record<string, unknown>,
): Promise<Delivery[]> {
  if (urls.length === 0) return [];
  const rows = urls.map((url) => {
    const id = crypto.randomUUID();
    return { id, scope: who.scope, scope_id: who.scopeId, workspace_id: workspaceId, event, url, payload: payloadFor(id) as Json };
  });
  const { error } = await db().from("api_webhook_deliveries").insert(rows);
  if (error) throw error;
  return rows.map((r) => ({ id: r.id, url: r.url, event, payload: r.payload, attempts: 0, scope: who.scope, scopeId: who.scopeId }));
}

/** How long a claimed delivery is held before another may try it. */
const CLAIM_MS = 60_000;

/** Take a delivery that's due, so no one else tries it meanwhile. */
export async function claimDelivery(id: string): Promise<boolean> {
  const now = new Date();
  const { data, error } = await db()
    .from("api_webhook_deliveries")
    .update({ next_attempt_at: new Date(now.getTime() + CLAIM_MS).toISOString() })
    .eq("id", id)
    .lte("next_attempt_at", now.toISOString())
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** How a try went: delivered, or when it's next tried (null: given up). */
export async function settleDelivery(
  id: string,
  outcome: { attempts: number; status: number | null; error: string | null; delivered: boolean; nextAttemptAt: string | null },
): Promise<void> {
  const { error } = await db()
    .from("api_webhook_deliveries")
    .update({
      attempts: outcome.attempts,
      last_status: outcome.status,
      last_error: outcome.error?.slice(0, 500) ?? null,
      delivered_at: outcome.delivered ? new Date().toISOString() : null,
      next_attempt_at: outcome.delivered ? null : outcome.nextAttemptAt,
    })
    .eq("id", id);
  if (error) throw error;
}

/** Deliveries due a try: the tick's. */
export async function dueDeliveries(limit = 50): Promise<Delivery[]> {
  const { data, error } = await db()
    .from("api_webhook_deliveries")
    .select("id, url, event, payload, attempts, scope, scope_id")
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: r.id, url: r.url, event: r.event, payload: r.payload, attempts: r.attempts, scope: r.scope, scopeId: r.scope_id }));
}

export type DeliveryView = {
  id: string;
  event: WebhookEvent;
  url: string;
  workspaceId: string | null;
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
};

/** The scope's latest deliveries, for its settings page. */
export async function recentDeliveries(who: WebhookScope, limit = 20): Promise<DeliveryView[]> {
  const { data, error } = await db()
    .from("api_webhook_deliveries")
    .select("id, event, url, workspace_id, attempts, last_status, last_error, delivered_at, next_attempt_at, created_at")
    .eq("scope", who.scope)
    .eq("scope_id", who.scopeId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    event: r.event,
    url: r.url,
    workspaceId: r.workspace_id,
    attempts: r.attempts,
    lastStatus: r.last_status,
    lastError: r.last_error,
    deliveredAt: r.delivered_at,
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
  }));
}

/** Forget deliveries done with (delivered or given up) more than 30 days ago. */
export async function pruneDeliveries(now = Date.now()): Promise<void> {
  const { error } = await db()
    .from("api_webhook_deliveries")
    .delete()
    .is("next_attempt_at", null)
    .lt("created_at", new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString());
  if (error) throw error;
}
