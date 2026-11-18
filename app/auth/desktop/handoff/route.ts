import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { redirectBase } from "@/lib/auth/complete-sign-in";
import { DESKTOP_CONTEXT_COOKIE, desktopDestination, readDesktopContext } from "@/lib/auth/desktop/grant";
import { createDesktopTicket } from "@/lib/auth/desktop/session";
import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { activeOrgId } from "@/lib/orgs/server";
import { mustSetUpActiveOrg } from "@/lib/orgs/setup.deps";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const reply = (body: object, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!isSameOriginRequest(request)) return reply({ error: "Forbidden" }, 403);
  const owner = await getOwner();
  if (!owner?.email) return reply({ error: "Sign in again to open the desktop app." }, 401);
  const context = readDesktopContext((await cookies()).get(DESKTOP_CONTEXT_COOKIE)?.value);
  if (!context) return reply({ error: "Desktop sign-in expired. Start again from the app." }, 410);
  if (await mustSetUpActiveOrg()) return reply({ error: "Finish setting up your org before opening the desktop app." }, 409);
  const body = await request.json().catch(() => null);
  if (!body || (body.next !== undefined && typeof body.next !== "string")) return reply({ error: "Invalid destination." }, 400);
  const base = redirectBase(new URL(request.url));
  // An independent, single-use session for this exact account. No email is sent,
  // and the browser's rotating refresh token never leaves its own cookie jar.
  const orgId = (await activeOrgId()) ?? null;
  const ticket = await createDesktopTicket(
    { id: owner.id, email: owner.email }, context, base, desktopDestination(body.next ?? context.next),
    (email) => createSupabaseAdminClient().auth.admin.generateLink({ type: "magiclink", email }),
    orgId,
  );
  if (!ticket) return reply({ error: "Could not open the desktop app. Please try again." }, 503);
  const query = new URLSearchParams({ desktop_ticket: ticket, state: context.state });
  return reply({ deepLink: `runtime://signin?${query}`, loopback: `http://127.0.0.1:47823/?${query}` });
}
