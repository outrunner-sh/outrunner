import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { boxSummary } from "@/lib/missions/box";
import { lastRecordedResponse, sessionById } from "@/lib/missions/store";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ id: string; runnerId: string }> };

/** A Ship under the owner's Mission, opened in the Ships pane: its brief
 *  and its latest response (from its box, else as last recorded). */
export async function GET(_request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id, runnerId } = await context.params;
  const runner = await sessionById(runnerId);
  if (!runner || runner.ownerId !== owner.id || runner.parentMissionId !== id) {
    return NextResponse.json({ error: "Ship not found." }, { status: 404 });
  }
  const [summary, brief] = await Promise.all([
    boxSummary(runner).catch(() => null),
    createSupabaseAdminClient().from("mission_runner_briefs").select("brief").eq("runner_id", runner.id).maybeSingle(),
  ]);
  const latest = summary?.lastAssistantMessage ?? (await lastRecordedResponse(runner.id));
  return NextResponse.json(
    { brief: brief.data?.brief ?? null, latestResponse: latest, live: summary !== null, status: runner.status },
    { headers: { "cache-control": "no-store" } },
  );
}
