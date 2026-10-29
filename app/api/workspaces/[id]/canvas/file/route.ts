import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { sniffImage } from "@/lib/runtime/chat-image";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { CANVAS_HTML_CSP, CANVAS_INERT_CSP, canvasKind, VISUAL_EMBED_SCRIPT } from "@/lib/session/canvas";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * One file of a cloud session's Canvas (`?path=`, in the folder), read off
 * its box, for the panel to show; its owner's alone. Served as what its name
 * says it is, and never as anything that can reach the app: a page
 * (`.html`) in a sandbox of its own (CANVAS_HTML_CSP), an image only when
 * its bytes are one (an SVG inert), and anything else as plain text or a
 * download. A page shown inline in a reply (`&embed=1`) gets a script after
 * its own that tells the reply its height (VISUAL_EMBED_SCRIPT). Read only,
 * so no Origin check: a GET carries the owner's cookie.
 */
export async function GET(request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  const params = new URL(request.url).searchParams;
  const path = params.get("path")?.trim() ?? "";
  if (!path) return NextResponse.json({ error: "Name a file in the Canvas." }, { status: 400 });
  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Canvas",
    needsComputer: "The Canvas needs a Runtime Computer provider.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, agent, identity } = reach.reached;
  if (workspace.ownerId !== owner.id) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });

  let bytes: Uint8Array;
  try {
    bytes = await agent.readCanvasFile(identity, path);
  } catch (error) {
    if (error instanceof AgentRequestError) {
      if (error.status === 404) return NextResponse.json({ error: "No such file in the Canvas." }, { status: 404 });
      if (error.status === 413) return NextResponse.json({ error: "That file is too large to show (over 5 MB)." }, { status: 413 });
      if (error.status === 400) return NextResponse.json({ error: "That isn't a file in the Canvas." }, { status: 400 });
    }
    console.warn(`Canvas: couldn't read ${path} of ${workspace.id}`, error);
    return NextResponse.json({ error: "Couldn't read that file off the box." }, { status: 502 });
  }

  const kind = canvasKind(path);
  const headers: Record<string, string> = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": CANVAS_INERT_CSP,
  };
  switch (kind) {
    case "html":
      headers["Content-Type"] = "text/html; charset=utf-8";
      headers["Content-Security-Policy"] = CANVAS_HTML_CSP;
      if (params.get("embed") === "1") {
        const script = new TextEncoder().encode(VISUAL_EMBED_SCRIPT);
        const page = new Uint8Array(bytes.length + script.length);
        page.set(bytes);
        page.set(script, bytes.length);
        bytes = page;
      }
      break;
    case "svg":
      headers["Content-Type"] = "image/svg+xml";
      break;
    case "image": {
      const type = sniffImage(bytes);
      if (!type) return NextResponse.json({ error: "That file isn't the image its name says." }, { status: 415 });
      headers["Content-Type"] = type;
      break;
    }
    case "other":
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Disposition"] = `attachment; filename="${(path.split("/").pop() ?? "file").replace(/[^\w.-]/g, "_")}"`;
      break;
    default:
      headers["Content-Type"] = "text/plain; charset=utf-8";
  }
  return new NextResponse(new Uint8Array(bytes), { headers });
}
