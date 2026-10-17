import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { stripe } from "@/lib/billing/stripe";
import { handleEvent } from "@/lib/billing/sync";
import { syncDeps } from "@/lib/billing/stripe-deps";
import { optionalEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Stripe's webhook. Trusts nothing but the signature, checked on the raw body
 * with STRIPE_WEBHOOK_SECRET; then keeps the copy of the subscription the
 * event concerns (lib/billing/sync.ts). A 5xx asks Stripe to deliver again.
 */
export async function POST(request: Request) {
  const secret = optionalEnv("STRIPE_WEBHOOK_SECRET");
  if (!secret) {
    return NextResponse.json({ error: "STRIPE_WEBHOOK_SECRET is not set on this server." }, { status: 503 });
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing Stripe signature." }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(await request.text(), signature, secret);
  } catch {
    return NextResponse.json({ error: "Invalid Stripe signature." }, { status: 400 });
  }
  try {
    return NextResponse.json({ received: true, outcome: await handleEvent(event, syncDeps) });
  } catch (error) {
    console.error(`Stripe event ${event.id} (${event.type}) failed; Stripe will retry`, error);
    return NextResponse.json({ error: "Could not handle the event." }, { status: 500 });
  }
}
