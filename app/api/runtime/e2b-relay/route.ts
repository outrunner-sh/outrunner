import { NextResponse } from "next/server";

import { getStoredE2b } from "@/lib/db/credentials";
import { bearerMatches } from "@/lib/http/bearer";
import { GATE_SECRET_ENV, GATE_SECRET_HEADER } from "@/lib/previews/wire";
import { AGENT_PORT } from "@/lib/runtime/daytona/deploy";
import { e2bRoute } from "@/lib/runtime/sandbox/e2b-route";
import { assertPublicHost } from "@/lib/runtime/user-e2b-checks";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * Where the custom server's relay (relay.ts) opens a browser's WebSocket to a
 * box in a user's self-hosted E2B: their client-proxy and the routing headers
 * naming the box. Only that server, after checking the browser's ticket for
 * this box and port, can ask (the gate secret); the destination comes from
 * the box's owner's stored E2B, never the request, and must still be public.
 */
export async function POST(request: Request) {
  const key = process.env[GATE_SECRET_ENV];
  if (!key || !bearerMatches(`Bearer ${request.headers.get(GATE_SECRET_HEADER) ?? ""}`, key)) {
    return new Response(null, { status: 403 });
  }
  let body: { id?: unknown; port?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof body.id !== "string" || !body.id || body.port !== AGENT_PORT) return new Response(null, { status: 400 });

  const { data, error } = await createSupabaseAdminClient()
    .from("runtime_computers")
    .select("owner_id")
    .eq("provider", "user-e2b")
    .eq("daytona_sandbox_id", body.id)
    .limit(1)
    .maybeSingle();
  if (error) return new Response(null, { status: 502 });
  if (!data) return new Response(null, { status: 404 });

  const stored = await getStoredE2b(data.owner_id);
  if (!stored?.sandboxUrl) return new Response(null, { status: 404 });
  try {
    await assertPublicHost(stored.sandboxUrl);
  } catch {
    return new Response(null, { status: 403 });
  }
  return NextResponse.json(e2bRoute(body.id, AGENT_PORT, stored.sandboxUrl));
}
