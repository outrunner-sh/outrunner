import { NextResponse } from "next/server";

import { changeWebhooks, webhookView } from "@/lib/api/webhook-routes";
import { orgCaller } from "@/lib/orgs/routes";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The org's webhooks (Settings → Org → API keys), its admins': the endpoint
 * that hears every event of sessions its org keys start, the secret they're
 * signed with, and the latest deliveries (lib/api/webhooks.deps.ts).
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  return NextResponse.json(await webhookView({ scope: "org", scopeId: id }));
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  return changeWebhooks(request, { scope: "org", scopeId: id }, caller.owner);
}
