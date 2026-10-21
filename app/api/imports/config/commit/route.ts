import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { saveAgentConfig } from "@/lib/db/agent-config";
import { isSameOriginRequest } from "@/lib/http/guards";
import { ImportError } from "@/lib/imports/commit";
import { commitConfig } from "@/lib/imports/config";
import { ImportConfigCommitRequest } from "@/lib/runtime/import-scan";
import { SNAPSHOT_BUCKET } from "@/lib/runtime/storage/snapshots";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Keep the user's picked setup — the archive the desktop app uploaded, their
 * MCP servers (sealed) and plugin settings — for their cloud computers,
 * replacing any earlier import's. Sessions started from now get it.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const parsed = ImportConfigCommitRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "That isn't a setup to import." }, { status: 400 });
  }
  const bucket = createSupabaseAdminClient().storage.from(SNAPSHOT_BUCKET);
  try {
    await commitConfig(owner.id, parsed.data, {
      async storedSize(path) {
        const folder = path.slice(0, path.lastIndexOf("/"));
        const name = path.slice(path.lastIndexOf("/") + 1);
        const { data, error } = await bucket.list(folder, { search: name, limit: 10 });
        if (error) throw error;
        const size = (data ?? []).find((o) => o.name === name)?.metadata?.size;
        return typeof size === "number" ? size : null;
      },
      save: (config) => saveAgentConfig(owner.id, config),
      async remove(path) {
        const { error } = await bucket.remove([path]);
        if (error) throw error;
      },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ImportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Could not keep an imported setup", error);
    return NextResponse.json({ error: "Could not keep your settings. Please try again." }, { status: 502 });
  }
}
