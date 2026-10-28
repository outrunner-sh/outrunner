import { NextResponse } from "next/server";

import { reviewEventsUrl } from "@/lib/automations/review-view";
import { reviewViewDeps } from "@/lib/automations/review-view.deps";
import { isUuid } from "@/lib/ids";
import { orgCaller } from "@/lib/orgs/routes";

type Params = { params: Promise<{ id: string; runId: string }> };

/**
 * A live review session's conversation (the org's connector's), for the
 * org's admins: the box's event stream, passed on as it comes. Read here, on
 * the server, so its token (good for all of the box) never reaches the
 * browser. A reconnect resumes where it left off (Last-Event-ID).
 */
export async function GET(request: Request, { params }: Params) {
  const { id, runId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if (!isUuid(runId)) return NextResponse.json({ error: "No such review session." }, { status: 404 });

  let upstreamUrl: string | null;
  try {
    upstreamUrl = await reviewEventsUrl(id, runId, request.headers.get("last-event-id"), reviewViewDeps);
  } catch (error) {
    console.error(`Couldn't open run ${runId}'s review session`, error);
    return NextResponse.json({ error: "Couldn't read the review session. Try again." }, { status: 502 });
  }
  // 204 ends an EventSource's reconnecting: there's nothing live to read.
  if (!upstreamUrl) return new Response(null, { status: 204 });

  const upstream = await fetch(upstreamUrl, {
    headers: { Accept: "text/event-stream" },
    cache: "no-store",
    signal: request.signal,
  }).catch((error: unknown) => {
    console.error(`Couldn't reach run ${runId}'s box`, error);
    return null;
  });
  if (!upstream?.ok || !upstream.body) {
    return NextResponse.json({ error: "Couldn't reach the review session's box." }, { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
