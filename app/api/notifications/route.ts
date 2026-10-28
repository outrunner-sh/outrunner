import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getPreferences } from "@/lib/db/notification-preferences";
import { DEFAULT_PREFERENCES } from "@/lib/notifications/events";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** How far back a page that just opened looks: what happened while it was
 *  closed is the sidebar's to show, not a burst of notifications. */
const RECENT_MS = 10 * 60_000;

/**
 * The user's notifications from `?after=` on (an ISO time from this route's
 * own `now`; the last few minutes at most), oldest first, for the browser to
 * show (hooks/use-notifications.ts), with whether they want them shown there
 * and which kinds. Without `after`, none: only `now`, the server's clock, for
 * the page to start from, so a browser clock that runs fast loses nothing.
 * From `after` inclusive: the page drops the ids it has seen, and rows
 * recorded together (one time) are never cut in two by the limit.
 */
export async function GET(request: Request) {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const now = new Date().toISOString();
  const after = new URL(request.url).searchParams.get("after");
  if (!after || Number.isNaN(Date.parse(after))) {
    return NextResponse.json({ notifications: [], now }, { headers: { "Cache-Control": "no-store" } });
  }
  const floor = Date.now() - RECENT_MS;
  const since = Date.parse(after) > floor ? after : new Date(floor).toISOString();
  const supabase = await createSupabaseServerClient();
  const [rows, preferences] = await Promise.all([
    supabase
      .from("session_notifications")
      .select("id, workspace_id, kind, title, body, created_at")
      .eq("user_id", owner.id)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(20),
    // Unreadable for a moment: the defaults, not nothing shown.
    getPreferences(owner.id).catch(() => DEFAULT_PREFERENCES),
  ]);
  // A deploy ahead of its migration: nothing to show yet.
  if (rows.error) return NextResponse.json({ notifications: [], now, browser: false, kinds: [] });
  return NextResponse.json(
    {
      notifications: (rows.data ?? []).map((n) => ({
        id: n.id,
        workspaceId: n.workspace_id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        createdAt: n.created_at,
      })),
      now,
      browser: preferences.browser,
      kinds: preferences.kinds,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
