import { NextResponse } from "next/server";

import { workspaceForPreview } from "@/lib/db/previews";
import { isUuid } from "@/lib/ids";
import { previewRequestValid } from "@/lib/previews/box-request";
import { createSessionPreview } from "@/lib/previews/manage";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A request's body is a session, a port and a label. */
const MAX_BODY_BYTES = 4096;

/**
 * A preview made by a session's agent, from its box (`runtime-agent
 * preview`, runtime-agent/internal/preview): `{ workspaceId, port, label? }`,
 * signed with the box's secret (lib/previews/box-request.ts). The session
 * must be one on that box. The preview is a sign-in one, whatever's asked
 * (lib/previews/manage.ts): only its owner, in Outrunner, makes one public.
 * A port that has one answers with it.
 */
export async function POST(request: Request) {
  const sandboxId = request.headers.get("x-outrunner-sandbox");
  const body = await request.text();
  if (!sandboxId || body.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Not a box's request." }, { status: 400 });
  }

  const { data: computers, error } = await createSupabaseAdminClient()
    .from("runtime_computers")
    .select("id, workspace_id, agent_secret")
    .eq("daytona_sandbox_id", sandboxId)
    .limit(5);
  if (error) {
    console.error("Preview: couldn't read the box", error);
    return NextResponse.json({ error: "Outrunner couldn't look up this box. Try again." }, { status: 503 });
  }
  const signed = {
    sandboxId,
    timestamp: request.headers.get("x-outrunner-timestamp"),
    signature: request.headers.get("x-outrunner-signature"),
    body,
  };
  const computer = (computers ?? []).find((c) => c.agent_secret && previewRequestValid(c.agent_secret, signed));
  if (!computer) return NextResponse.json({ error: "Bad signature." }, { status: 401 });

  let asked: { workspaceId?: unknown; port?: unknown; label?: unknown };
  try {
    asked = JSON.parse(body) as typeof asked;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const workspace = typeof asked.workspaceId === "string" && isUuid(asked.workspaceId) ? await workspaceForPreview(asked.workspaceId) : null;
  // A session of this box's: its own, or one the box records it hosts.
  if (!workspace || (computer.workspace_id !== workspace.id && workspace.computerId !== computer.id)) {
    return NextResponse.json({ error: "That session isn't on this box." }, { status: 404 });
  }

  const made = await createSessionPreview({ kind: "agent" }, workspace, { port: asked.port, label: asked.label, mode: "login" });
  if (!made.ok) return NextResponse.json({ error: made.message }, { status: made.status });
  return NextResponse.json({ preview: made.value }, { status: made.status ?? 200, headers: { "cache-control": "no-store" } });
}
