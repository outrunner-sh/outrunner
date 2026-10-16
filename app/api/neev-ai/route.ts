import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { outrunnerModelsFor } from "@/lib/db/credentials";

export const dynamic = "force-dynamic";

/**
 * Whether Outrunner's own models are there for this user (on their own
 * OpenRouter key, or the server's), so a session can start without their
 * Claude: a cloud session, or one on a Mac whose Claude Code isn't logged in.
 * Never the key itself.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  return NextResponse.json({ available: await outrunnerModelsFor(owner.id) });
}
