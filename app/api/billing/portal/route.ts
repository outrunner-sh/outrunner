import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { portalDestination } from "@/lib/billing/checkout";
import { billingMode } from "@/lib/billing/mode";
import { checkoutDeps } from "@/lib/billing/stripe-deps";
import { requireEnv } from "@/lib/env";
import { isSameOriginRequest } from "@/lib/http/guards";

export const dynamic = "force-dynamic";

/** Manage a plan: answers `{ url }`, Stripe's customer portal for the user,
 *  to change plan, cancel, update a card, or see invoices. */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  if (billingMode() !== "stripe") {
    return NextResponse.json({ error: "Plans aren't for sale on this server." }, { status: 404 });
  }
  try {
    const url = await portalDestination(owner.id, requireEnv("RUNTIME_BASE_URL"), checkoutDeps);
    if (!url) return NextResponse.json({ error: "You have no plan to manage yet." }, { status: 409 });
    return NextResponse.json({ url });
  } catch (error) {
    console.error("Could not open the billing portal", error);
    return NextResponse.json({ error: "Couldn't reach Stripe. Try again in a moment." }, { status: 502 });
  }
}
