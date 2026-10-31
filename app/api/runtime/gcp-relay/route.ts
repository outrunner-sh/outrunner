import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/http/bearer";
import { GATE_SECRET_ENV, GATE_SECRET_HEADER } from "@/lib/previews/wire";
import { findGcpResource, gcpConnection } from "@/lib/db/gcp";
import { gcpForward } from "@/lib/runtime/gcp/ssh";
import { AGENT_PORT } from "@/lib/runtime/daytona/deploy";

/** Only the custom server, after verifying the browser's scoped relay ticket,
 * can resolve this loopback URL. No public request can supply a destination. */
export async function POST(request: Request) {
  const key = process.env[GATE_SECRET_ENV];
  if (!key || !bearerMatches(`Bearer ${request.headers.get(GATE_SECRET_HEADER) ?? ""}`, key)) return new Response(null, { status: 403 });
  try {
    const body = await request.json();
    if (body?.port !== AGENT_PORT) return new Response(null, { status: 400 });
    const r = await findGcpResource(body.id);
    if (r.state !== "ready") return new Response(null, { status: 409 });
    const c = await gcpConnection(r.user_id, r.connection_id);
    if (!c) return new Response(null, { status: 404 });
    return NextResponse.json({ url: await gcpForward(c, r, AGENT_PORT) });
  } catch { return new Response(null, { status: 502 }); }
}
