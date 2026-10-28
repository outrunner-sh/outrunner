import { NextResponse } from "next/server";

import { listAuditEvents } from "@/lib/db/audit";
import { orgCaller } from "@/lib/orgs/routes";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * An org's audit log (Settings → Org → Audit log; lib/audit/actions.ts), for
 * its admins: newest first, a page at a time, `?before=<event id>` for the
 * page after one.
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  const raw = new URL(request.url).searchParams.get("before");
  const before = raw === null ? undefined : Number(raw);
  if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) {
    return NextResponse.json({ error: "Ask for the page before an event." }, { status: 400 });
  }
  return NextResponse.json(await listAuditEvents(id, before), { headers: { "cache-control": "no-store" } });
}
