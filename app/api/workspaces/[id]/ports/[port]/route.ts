import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { previewablePort } from "@/lib/runtime/box-ports";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";

type RouteContext = { params: Promise<{ id: string; port: string }> };

/** How long a preview link works: a working day, as the editor's. */
const PREVIEW_LINK_TTL_SECONDS = 8 * 60 * 60;

/**
 * A link to a server running on a cloud session's box, for its owner's
 * browser: the provider's signed preview URL, its credential in the host, so
 * the app's pages, assets and sockets all get through. Not the agent's own
 * port or the provider's daemon's (lib/runtime/box-ports.ts): a link to
 * those would be a bearer key to the box's control, good for hours.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const { id, port: raw } = await context.params;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!previewablePort(port)) {
    return NextResponse.json({ error: "That isn't a port to open." }, { status: 400 });
  }

  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Preview",
    needsComputer: "Previews run on Outrunner's cloud computers.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, provider, sandboxId } = reach.reached;

  try {
    const url = await provider.browserUrl(sandboxId, port, PREVIEW_LINK_TTL_SECONDS);
    if (!url) {
      return NextResponse.json({ error: "This session's sandbox can't open a preview in a browser." }, { status: 409 });
    }
    return NextResponse.json({ url });
  } catch (error) {
    console.error(`Preview: failed for ${workspace.id} port ${port}`, error);
    return NextResponse.json({ error: "Couldn't open that preview. Please try again." }, { status: 502 });
  }
}
