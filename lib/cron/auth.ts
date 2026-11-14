import { NextResponse } from "next/server";

import { optionalEnv } from "@/lib/env";
import { bearerMatches } from "@/lib/http/bearer";

/**
 * The check every cron route (app/api/*\/tick, app/api/billing/reconcile)
 * makes before anything else: the Cloudflare cron's BILLING_CRON_SECRET, as
 * a bearer token. Null when the request may go on; otherwise the answer to
 * give it (503 when the secret isn't set here, 401 when it doesn't match).
 */
export function cronAuth(request: Request): NextResponse | null {
  const secret = optionalEnv("BILLING_CRON_SECRET");
  if (!secret) return NextResponse.json({ error: "BILLING_CRON_SECRET is not set on this server." }, { status: 503 });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  }
  return null;
}

/** Whether the request carries BILLING_CRON_SECRET (false when it isn't set):
 *  for a route that answers anyone, and the operator more (/api/health). */
export function hasCronSecret(request: Request): boolean {
  const secret = optionalEnv("BILLING_CRON_SECRET");
  return !!secret && bearerMatches(request.headers.get("authorization"), secret);
}
