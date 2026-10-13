import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { keySource } from "@/lib/openrouter/keys";

export const dynamic = "force-dynamic";

/**
 * Whether this server runs Outrunner's own models (it has an OpenRouter key),
 * so a session can start without the user's Claude: a cloud session, or one on
 * a Mac whose Claude Code isn't logged in. Never the key itself.
 */
export async function GET() {
  if (!(await getOwner())) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  return NextResponse.json({ available: keySource() !== null });
}
