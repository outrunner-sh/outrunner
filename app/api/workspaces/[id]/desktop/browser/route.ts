import { NextResponse } from "next/server";

import { reachDesktop } from "@/lib/runtime/desktop-access";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Opens the web browser on the session's desktop, for its owner to use in the
 * Desktop tab: the agent's own Chromium, so a site they sign in to there is
 * signed in for the agent too (lib/runtime/sandbox/daytona.ts OPEN_WEB_BROWSER).
 */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const reach = await reachDesktop(request, id);
  if (!reach.ok) return reach.response;
  const { workspace, provider, sandboxId } = reach.reached;

  try {
    if (!(await provider.openDesktopBrowser(sandboxId))) {
      return NextResponse.json({ error: "This session's sandbox has no desktop." }, { status: 409 });
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error(`Desktop: couldn't open the browser for ${workspace.id}`, error);
    return NextResponse.json({ error: "Couldn't open the browser. Please try again." }, { status: 502 });
  }
}
