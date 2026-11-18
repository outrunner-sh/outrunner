import { connection, NextResponse } from "next/server";

import { buildInfo } from "@/lib/observability/build";
import { isDraining } from "@/lib/observability/drain";

/**
 * Liveness: the process is up and answering. Touches nothing (no database,
 * no provider), so it stays cheap enough for an uptime check every minute,
 * and a database outage doesn't read as the app being down. Readiness, with
 * the database probe, is /api/health.
 */
export async function GET() {
  // Per request, never prerendered at build.
  await connection();
  return NextResponse.json({
    ok: true,
    ...buildInfo(),
    ...(isDraining() ? { draining: true } : {}),
  });
}
