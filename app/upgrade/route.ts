import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { BILLING_PATH, checkoutDestination, requestedPlan } from "@/lib/billing/checkout";
import { billingMode } from "@/lib/billing/mode";
import { checkoutDeps } from "@/lib/billing/stripe-deps";
import { requireEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * A plan bought from a link: `/upgrade?plan=pro|max&interval=month|year`, which
 * the landing site's pricing buttons point at. Signed out, it goes through
 * sign-in and comes back here; signed in, straight to Stripe Checkout (or the
 * portal, for a user who already pays). Anything it can't do lands on
 * Settings → Billing, which explains.
 *
 * A GET that starts a checkout: at worst a crafted link shows a signed-in user
 * Stripe's checkout page, which charges nothing until they pay on it.
 */
export async function GET(request: Request) {
  const base = requireEnv("RUNTIME_BASE_URL");
  const { plan, interval } = requestedPlan(new URL(request.url).searchParams);
  const to = (path: string) => NextResponse.redirect(new URL(path, base), 303);

  const owner = await getOwner();
  if (!owner) {
    const back = plan ? `/upgrade?plan=${plan}&interval=${interval}` : BILLING_PATH;
    return to(`/signin?next=${encodeURIComponent(back)}`);
  }
  if (!plan || billingMode() !== "stripe") return to(BILLING_PATH);
  try {
    const destination = await checkoutDestination(owner, plan, interval, base, checkoutDeps);
    return NextResponse.redirect(destination.url, 303);
  } catch (error) {
    console.error("Could not start a checkout from a link", error);
    return to(`${BILLING_PATH}?checkout=error`);
  }
}
