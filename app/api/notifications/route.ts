import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getPreferences } from "@/lib/db/notification-preferences";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** How far back a page that just opened looks: what happened while it was
 *  closed is the sidebar's to show, not a burst of notifications. */
const RECENT_MS = 10 * 60_000;

/**
 * The user's notifications since `?after=` (an ISO time; the last few minutes
 * at most), oldest first, for the browser and the Mac app to show
 * (hooks/use-notifications.ts), with whether they want them shown there and
 * which kinds.
 */
export async function GET(request: Request) {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const after = new URL(request.url).searchParams.get("after");
  const floor = Date.now() - RECENT_MS;
  const since = after && !Number.isNaN(Date.parse(after)) && Date.parse(after) > floor ? after : new Date(floor).toISOString();
  const supabase = await createSupabaseServerClient();
  const [rows, preferences] = await Promise.all([
    supabase
      .from("session_notifications")
      .select("id, workspace_id, kind, title, body, created_at")
      .eq("user_id", owner.id)
      .gt("created_at", since)
      .order("created_at", { ascending: true })
      .limit(20),
    getPreferences(owner.id).catch(() => null),
  ]);
  // A deploy ahead of its migration: nothing to show yet.
  if (rows.error) return NextResponse.json({ notifications: [], browser: false, kinds: [] });
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
      browser: preferences?.browser ?? true,
      kinds: preferences?.kinds ?? [],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
