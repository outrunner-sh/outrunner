import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { hasOwnOpenRouterKey } from "@/lib/db/credentials";
import { keySource } from "@/lib/openrouter/keys";

export const dynamic = "force-dynamic";

/**
 * Whether Outrunner's own models are there for this user (on their own
 * OpenRouter key, or the server's), so a session can start without their
 * Claude: a cloud session, or one on a Mac whose Claude Code isn't logged in;
 * and `ownKey`, whether they run on the user's own key, for the model menu to
 * say. Never the key itself.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const ownKey = await hasOwnOpenRouterKey(owner.id);
  const source = keySource();
  return NextResponse.json({
    available: ownKey || source !== null,
    ownKey,
    serverModels: source !== null,
    allowance: source === "per-user",
  });
}
