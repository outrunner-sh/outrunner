import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { getOwner } from "@/lib/auth/owner";
import { billingBuyer } from "@/lib/billing/buyer";
import { portalDestination } from "@/lib/billing/checkout";
import { billingMode } from "@/lib/billing/mode";
import { checkoutDeps } from "@/lib/billing/stripe-deps";
import { requireEnv } from "@/lib/env";
import { isSameOriginRequest } from "@/lib/http/guards";

/** Manage the plan of the org the user is looking at, as its admin: answers
 *  `{ url }`, Stripe's customer portal for the org, to change plan, cancel,
 *  update a card, or see invoices. */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  if (billingMode() !== "stripe") {
    return NextResponse.json({ error: "Plans aren't for sale on this server." }, { status: 404 });
  }
  const who = await billingBuyer(owner);
  if ("refusal" in who) return NextResponse.json({ error: who.refusal }, { status: who.status });
  try {
    const url = await portalDestination(who.buyer.orgId, requireEnv("RUNTIME_BASE_URL"), checkoutDeps);
    if (!url) return NextResponse.json({ error: "This org has no plan to manage yet." }, { status: 409 });
    await recordAudit({ orgId: who.buyer.orgId, actor: owner, action: "billing.portal_opened" });
    return NextResponse.json({ url });
  } catch (error) {
    console.error("Could not open the billing portal", error);
    return NextResponse.json({ error: "Couldn't reach Stripe. Try again in a moment." }, { status: 502 });
  }
}
