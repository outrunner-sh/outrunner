import { NextResponse } from "next/server";

import { getStoredE2b } from "@/lib/db/credentials";
import { bearerMatches } from "@/lib/http/bearer";
import { GATE_SECRET_ENV, GATE_SECRET_HEADER } from "@/lib/previews/wire";
import { NOVNC_PORT } from "@/lib/runtime/box-ports";
import { AGENT_PORT } from "@/lib/runtime/daytona/deploy";
import { E2B_TRAFFIC_TOKEN_HEADER, e2bRoute, readE2bRelaySecret } from "@/lib/runtime/sandbox/e2b-route";
import { E2B_CLOUD_DOMAIN } from "@/lib/runtime/sandbox/e2b-sdk";
import { assertPublicHost } from "@/lib/runtime/user-e2b-checks";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * Where the custom server's relay (relay.ts) opens a browser's WebSocket to a
 * box in a user's E2B (its agent, or its desktop's noVNC proxy): their
 * self-hosted client-proxy with the routing headers naming the box and port,
 * or the box's own host on E2B's cloud, with its traffic token either way.
 * Only that server, after checking the browser's ticket for this box and
 * port, can ask (the gate secret), with what the ticket carried sealed: the
 * box's owner and token. The box is looked up as that owner's (a user's E2B
 * picks its own ids, so another user's box may share one), and the
 * destination comes from their stored E2B, never the request, and must
 * still be public.
 */
/** The shape of a box id on E2B's cloud: letters and digits only. */
const E2B_CLOUD_SANDBOX_ID = /^[a-z0-9]{1,64}$/i;

export async function POST(request: Request) {
  const key = process.env[GATE_SECRET_ENV];
  if (!key || !bearerMatches(`Bearer ${request.headers.get(GATE_SECRET_HEADER) ?? ""}`, key)) {
    return new Response(null, { status: 403 });
  }
  let body: { id?: unknown; port?: unknown; secret?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response(null, { status: 400 });
  }
  // The agent, or the desktop's noVNC proxy: nothing else on a box is the
  // browser's to reach through here.
  if (typeof body.id !== "string" || !body.id || (body.port !== AGENT_PORT && body.port !== NOVNC_PORT)) {
    return new Response(null, { status: 400 });
  }
  const port = body.port;
  const { owner, token } = readE2bRelaySecret(typeof body.secret === "string" ? body.secret : undefined);
  // A ticket from before owners were bound into it: the browser reconnects
  // with a new one.
  if (!owner) return new Response(null, { status: 403 });

  const { data, error } = await createSupabaseAdminClient()
    .from("runtime_computers")
    .select("owner_id")
    .eq("provider", "user-e2b")
    .eq("daytona_sandbox_id", body.id)
    .eq("owner_id", owner)
    .limit(1)
    .maybeSingle();
  if (error) return new Response(null, { status: 502 });
  if (!data) return new Response(null, { status: 404 });

  const stored = await getStoredE2b(data.owner_id);
  if (!stored) return new Response(null, { status: 404 });
  if (!stored.sandboxUrl) {
    // E2B's cloud routes by host, a name of E2B's, not the user's. The id
    // came from the user's E2B (one they may once have self-hosted), so only
    // one E2B's cloud could have made goes into that name.
    if (!E2B_CLOUD_SANDBOX_ID.test(body.id)) return new Response(null, { status: 400 });
    return NextResponse.json({
      base: `https://${port}-${body.id}.${E2B_CLOUD_DOMAIN}`,
      headers: token ? { [E2B_TRAFFIC_TOKEN_HEADER]: token } : {},
    });
  }
  try {
    await assertPublicHost(stored.sandboxUrl);
  } catch {
    return new Response(null, { status: 403 });
  }
  return NextResponse.json(e2bRoute(body.id, port, stored.sandboxUrl, token));
}
