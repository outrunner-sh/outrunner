/**
 * The database side of Stripe billing: orgs' Stripe customers, the copy of
 * their subscriptions, and the webhook events handled (billing is the
 * org's). Service role throughout: the tables are service-role only, and the
 * webhook runs with no one signed in. Callers pass an org id they checked
 * the caller is an admin of, or one from Stripe, never from a request.
 */

import type { SubscriptionRecord } from "@/lib/billing/subscriptions";
import type { BillingInterval, PaidPlanId } from "@/lib/billing/plans";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

type SubscriptionRow = Database["public"]["Tables"]["subscriptions"]["Row"];

export async function customerIdFor(orgId: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("billing_customers")
    .select("stripe_customer_id")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw error;
  return data?.stripe_customer_id ?? null;
}

/** Store `customerId` as the org's (made by `userId`) unless one is stored
 *  already; the one stored either way. */
export async function claimCustomer(orgId: string, userId: string, customerId: string): Promise<string> {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("billing_customers")
    .upsert(
      { org_id: orgId, user_id: userId, stripe_customer_id: customerId },
      { onConflict: "org_id", ignoreDuplicates: true },
    );
  if (error) throw error;
  const stored = await customerIdFor(orgId);
  if (!stored) throw new Error("A Stripe customer was claimed but none is stored.");
  return stored;
}

export async function orgForCustomer(customerId: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("billing_customers")
    .select("org_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (error) throw error;
  return data?.org_id ?? null;
}

export async function subscriptionsFor(orgId: string): Promise<SubscriptionRecord[]> {
  // Ordered, so whoever reads them sees the same order every time.
  const { data, error } = await createSupabaseAdminClient()
    .from("subscriptions")
    .select("*")
    .eq("org_id", orgId)
    .order("stripe_subscription_id");
  if (error) throw error;
  return data.map(fromRow);
}

export async function subscriptionById(id: string): Promise<SubscriptionRecord | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("subscriptions")
    .select("*")
    .eq("stripe_subscription_id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? fromRow(data) : null;
}

/**
 * Store a subscription as fetched from Stripe at `fetchedAt`, unless a later
 * fetch is stored already: two webhooks racing can't leave the older state.
 * True when it was stored.
 */
export async function saveSubscription(record: SubscriptionRecord, fetchedAt: Date): Promise<boolean> {
  const supabase = createSupabaseAdminClient();
  const row = {
    stripe_subscription_id: record.stripeSubscriptionId,
    org_id: record.orgId,
    user_id: record.userId,
    stripe_customer_id: record.stripeCustomerId,
    status: record.status,
    plan: record.plan,
    price_lookup_key: record.priceLookupKey,
    billing_interval: record.billingInterval,
    current_period_start: record.currentPeriodStart.toISOString(),
    current_period_end: record.currentPeriodEnd.toISOString(),
    cancel_at_period_end: record.cancelAtPeriodEnd,
    past_due_since: record.pastDueSince?.toISOString() ?? null,
    synced_at: fetchedAt.toISOString(),
  };
  const { data: inserted, error: insertError } = await supabase
    .from("subscriptions")
    .upsert(row, { onConflict: "stripe_subscription_id", ignoreDuplicates: true })
    .select("stripe_subscription_id");
  if (insertError) throw insertError;
  if (inserted.length > 0) return true;
  const { data: updated, error } = await supabase
    .from("subscriptions")
    .update(row)
    .eq("stripe_subscription_id", record.stripeSubscriptionId)
    .lt("synced_at", row.synced_at)
    .select("stripe_subscription_id");
  if (error) throw error;
  return updated.length > 0;
}

/** Forget a subscription that no longer sells a plan of Outrunner's (its
 *  price was changed to one Outrunner doesn't know), so it grants nothing. */
export async function deleteSubscription(id: string): Promise<void> {
  const { error } = await createSupabaseAdminClient().from("subscriptions").delete().eq("stripe_subscription_id", id);
  if (error) throw error;
}

export async function eventHandled(id: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdminClient().from("stripe_events").select("id").eq("id", id).maybeSingle();
  if (error) throw error;
  return data !== null;
}

export async function recordEvent(id: string, type: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("stripe_events")
    .upsert({ id, type }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw error;
}

function fromRow(row: SubscriptionRow): SubscriptionRecord {
  return {
    stripeSubscriptionId: row.stripe_subscription_id,
    orgId: row.org_id,
    userId: row.user_id,
    stripeCustomerId: row.stripe_customer_id,
    status: row.status,
    plan: row.plan as PaidPlanId,
    priceLookupKey: row.price_lookup_key,
    billingInterval: row.billing_interval as BillingInterval | null,
    currentPeriodStart: new Date(row.current_period_start),
    currentPeriodEnd: new Date(row.current_period_end),
    cancelAtPeriodEnd: row.cancel_at_period_end,
    pastDueSince: row.past_due_since ? new Date(row.past_due_since) : null,
  };
}

/** Every subscription that may give a plan now (lib/billing/subscriptions.ts,
 *  entitles), a page at a time. */
export async function entitlingSubscriptions(): Promise<SubscriptionRecord[]> {
  const supabase = createSupabaseAdminClient();
  const rows: SubscriptionRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("subscriptions")
      .select("*")
      .in("status", ["active", "trialing", "past_due"])
      .order("stripe_subscription_id")
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows.map(fromRow);
  }
}

/** Since when an overage payment on one of the org's subscriptions has been
 *  failing, the earliest; null while all are paid up (and before the column,
 *  20261114120000_usage_limits_in_dollars.sql, is there). */
export async function overageUnpaidSince(orgId: string): Promise<Date | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("subscriptions")
    .select("overage_unpaid_since")
    .eq("org_id", orgId)
    .not("overage_unpaid_since", "is", null)
    .order("overage_unpaid_since")
    .limit(1);
  if (error && probeStatus(error) === "outdated") return null;
  if (error) throw error;
  const since = data?.[0]?.overage_unpaid_since;
  return since ? new Date(since) : null;
}
