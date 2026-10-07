import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { neevAiKey } from "@/lib/db/credentials";
import { isSameOriginRequest } from "@/lib/http/guards";
import { NeevAiUnavailableError } from "@/lib/openrouter/keys";

export const dynamic = "force-dynamic";

/**
 * The signed-in user's Neev AI key, created on first use. A local session's
 * page needs it to switch the session on the user's Mac to a Neev AI model.
 * POST, same-origin, never cached: it is a credential, if a capped one.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to use Neev AI." }, { status: 401 });
  }
  try {
    const key = await neevAiKey(owner.id);
    return NextResponse.json({ key }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof NeevAiUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    // OpenRouter's and the driver's messages stay in the log.
    console.error(`Could not get a Neev AI key for ${owner.id}`, error);
    return NextResponse.json({ error: "Neev AI is unavailable right now. Please try again." }, { status: 502 });
  }
}
