/**
 * The database side of Stripe billing: users' Stripe customers, the copy of
 * their subscriptions, and the webhook events handled. Service role
 * throughout: the tables are service-role only, and the webhook runs with no
 * one signed in. Callers pass a user id from the session or from Stripe,
 * never from a request.
 */

import type { SubscriptionRecord } from "@/lib/billing/subscriptions";
import type { BillingInterval, PaidPlanId } from "@/lib/billing/plans";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

type SubscriptionRow = Database["public"]["Tables"]["subscriptions"]["Row"];

export async function customerIdFor(userId: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("billing_customers")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.stripe_customer_id ?? null;
}

/** Store `customerId` as the user's unless one is stored already; the one
 *  stored either way. */
export async function claimCustomer(userId: string, customerId: string): Promise<string> {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("billing_customers")
    .upsert({ user_id: userId, stripe_customer_id: customerId }, { onConflict: "user_id", ignoreDuplicates: true });
  if (error) throw error;
  const stored = await customerIdFor(userId);
  if (!stored) throw new Error("A Stripe customer was claimed but none is stored.");
  return stored;
}

export async function userForCustomer(customerId: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("billing_customers")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ?? null;
}

export async function subscriptionsFor(userId: string): Promise<SubscriptionRecord[]> {
  const { data, error } = await createSupabaseAdminClient().from("subscriptions").select("*").eq("user_id", userId);
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

export async function saveSubscription(record: SubscriptionRecord): Promise<void> {
  const { error } = await createSupabaseAdminClient().from("subscriptions").upsert(
    {
      stripe_subscription_id: record.stripeSubscriptionId,
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
    },
    { onConflict: "stripe_subscription_id" },
  );
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
