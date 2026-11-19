import { NextResponse } from "next/server";

import { reachDesktop } from "@/lib/runtime/desktop-access";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The session's owner is using its desktop with their own mouse and keyboard:
 * the Desktop tab says so at most every few seconds while they do
 * (lib/session/desktop-view.ts inUseReporter), and the agent's desktop tools
 * that act on it hold off until they've stopped (runtime-agent/internal/desktop).
 */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const reach = await reachDesktop(request, id);
  if (!reach.ok) return reach.response;
  const { workspace, provider, sandboxId } = reach.reached;

  try {
    if (!(await provider.markDesktopInUse(sandboxId))) {
      return NextResponse.json({ error: "This session's sandbox has no desktop." }, { status: 409 });
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error(`Desktop: couldn't mark ${workspace.id}'s desktop in use`, error);
    return NextResponse.json({ error: "Couldn't reach the desktop." }, { status: 502 });
  }
}
