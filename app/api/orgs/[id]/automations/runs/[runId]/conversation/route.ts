import { NextResponse } from "next/server";

import { reviewView } from "@/lib/automations/review-view";
import { reviewViewDeps } from "@/lib/automations/review-view.deps";
import { isUuid } from "@/lib/ids";
import { orgCaller } from "@/lib/orgs/routes";

type Params = { params: Promise<{ id: string; runId: string }> };

const NOT_FOUND = { error: "No such review session." };

/** How a run's review session (the org's connector's) can be read, by the
 *  org's admins: live from its box, or its latest snapshot's conversation. */
export async function GET(request: Request, { params }: Params) {
  const { id, runId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if (!isUuid(runId)) return NextResponse.json(NOT_FOUND, { status: 404 });
  try {
    const view = await reviewView(id, runId, reviewViewDeps);
    if (!view) return NextResponse.json(NOT_FOUND, { status: 404 });
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`Couldn't read run ${runId}'s review session`, error);
    return NextResponse.json({ error: "Couldn't read the review session. Try again." }, { status: 502 });
  }
}
