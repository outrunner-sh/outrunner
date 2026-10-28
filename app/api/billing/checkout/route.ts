import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { billingBuyer } from "@/lib/billing/buyer";
import { checkoutDestination } from "@/lib/billing/checkout";
import { billingMode } from "@/lib/billing/mode";
import { checkoutDeps } from "@/lib/billing/stripe-deps";
import { requireEnv } from "@/lib/env";
import { isSameOriginRequest } from "@/lib/http/guards";

/**
 * Start a plan for the org the user is looking at, as its admin:
 * `{ plan: "pro" | "max", interval: "month" | "year" }`. Answers `{ url }`,
 * Stripe Checkout's page to send them to; for an org with a paid plan
 * already, the customer portal instead, to change it there.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  if (billingMode() !== "stripe") {
    return NextResponse.json({ error: "Plans aren't for sale on this server." }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as { plan?: unknown; interval?: unknown } | null;
  const plan = body?.plan === "pro" || body?.plan === "max" ? body.plan : null;
  const interval = body?.interval === "month" || body?.interval === "year" ? body.interval : null;
  if (!plan || !interval) {
    return NextResponse.json({ error: "Choose Pro or Max, monthly or yearly." }, { status: 400 });
  }
  const who = await billingBuyer(owner);
  if ("refusal" in who) return NextResponse.json({ error: who.refusal }, { status: who.status });
  try {
    return NextResponse.json(
      await checkoutDestination(who.buyer, plan, interval, requireEnv("RUNTIME_BASE_URL"), checkoutDeps),
    );
  } catch (error) {
    console.error("Could not start a checkout", error);
    return NextResponse.json({ error: "Couldn't reach Stripe. Try again in a moment." }, { status: 502 });
  }
}
