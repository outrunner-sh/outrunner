import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { billingMode } from "@/lib/billing/mode";
import { runReconcile } from "@/lib/billing/reconcile-run";
import { renewDueModelAllowances } from "@/lib/db/credentials";
import { optionalEnv } from "@/lib/env";

/**
 * One reconciler run (lib/billing/reconcile.ts), and the model allowances
 * due to renew for sessions already running, for the Cloudflare cron
 * (cloudflare/worker.ts, every 2 minutes). Not a user's route: it takes only
 * BILLING_CRON_SECRET, as a bearer token. Answers what the run did.
 */
export async function POST(request: Request) {
  const secret = optionalEnv("BILLING_CRON_SECRET");
  if (!secret) {
    return NextResponse.json({ error: "BILLING_CRON_SECRET is not set on this server." }, { status: 503 });
  }
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const report = await runReconcile();
    // Its own step: a failure here doesn't hide what the reconciler did.
    const allowancesRenewed =
      billingMode() === "stripe"
        ? await renewDueModelAllowances().catch((error: unknown) => {
            console.error("Renewing model allowances failed", error);
            return null;
          })
        : 0;
    return NextResponse.json({ ...report, allowancesRenewed });
  } catch (error) {
    console.error("Reconcile failed", error);
    return NextResponse.json({ error: "Reconcile failed." }, { status: 500 });
  }
}

/** Whether `header` is `Bearer <secret>`, compared in constant time. */
function bearerMatches(header: string | null, secret: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
