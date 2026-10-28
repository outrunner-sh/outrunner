import { NextResponse } from "next/server";

import { changeWebhooks, webhookView } from "@/lib/api/webhook-routes";
import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { signInFirst } from "@/lib/http/settings-save";

/**
 * The signed-in user's webhooks (Settings → API keys): for sessions their
 * personal keys and CLI start, as the org's are for its keys.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) return signInFirst();
  return NextResponse.json(await webhookView({ scope: "user", scopeId: owner.id }));
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return signInFirst();
  return changeWebhooks(request, { scope: "user", scopeId: owner.id }, owner.id);
}
