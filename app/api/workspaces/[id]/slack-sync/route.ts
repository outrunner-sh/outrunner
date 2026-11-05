import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { isUuid } from "@/lib/ids";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Turn a Slack-started session's sync with its thread on or off (Devin's
 * toggle): off, what's typed in either place stays there. The owner's own
 * session only (RLS).
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { sync?: unknown } | null;
  if (!isUuid(id) || typeof body?.sync !== "boolean") return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  // The row is the server's to write (20261105100000); the owner_id filter
  // below is the check that only this owner's session is said.
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("workspaces")
    .update({ slack_sync: body.sync })
    .eq("id", id)
    .eq("owner_id", owner.id)
    .not("slack_thread_url", "is", null)
    .select("slack_sync")
    .maybeSingle();
  if (error) throw error;
  if (!data) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  return NextResponse.json({ sync: data.slack_sync });
}
