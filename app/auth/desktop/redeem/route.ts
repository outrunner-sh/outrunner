import { NextResponse } from "next/server";

import { redirectBase } from "@/lib/auth/complete-sign-in";
import { redeemDesktopTicket } from "@/lib/auth/desktop/session";
import { isSameOriginRequest } from "@/lib/http/guards";
import { setActiveOrg } from "@/lib/orgs/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Called by the waiting webview with its native-only PKCE verifier. */
export async function POST(request: Request) {
  const reply = (body: object, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!isSameOriginRequest(request)) return reply({ error: "Forbidden" }, 403);
  const body = await request.json().catch(() => null);
  const supabase = await createSupabaseServerClient();
  const result = await redeemDesktopTicket(body, redirectBase(new URL(request.url)), supabase.auth);
  if ("error" in result) return reply({ error: result.error }, result.status);
  // This preference came from the browser's validated org context. The app's
  // normal org resolver checks membership again on every authenticated view.
  if (result.orgId) await setActiveOrg(result.orgId);
  return reply({ next: result.next });
}
