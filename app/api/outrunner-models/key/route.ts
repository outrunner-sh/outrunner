import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { outrunnerModelKey, NoOwnOpenRouterKeyError, type OpenRouterKeyUse } from "@/lib/db/credentials";
import { isSameOriginRequest } from "@/lib/http/guards";
import { ModelKeyRefusedError, OutrunnerModelsUnavailableError } from "@/lib/openrouter/keys";
import { StoredKeyUnreadableError } from "@/lib/openrouter/user-key";

export const dynamic = "force-dynamic";

/**
 * The signed-in user's key for Outrunner's models, created on first use. A
 * local session's page needs it to switch the session on the user's Mac to one
 * of them.
 * POST, same-origin, never cached: it is a credential, if a capped one.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to use Outrunner's models." }, { status: 401 });
  }
  // Which key: the user's own, Outrunner's, or (no body) theirs if they have one.
  const body = (await request.json().catch(() => null)) as { use?: unknown } | null;
  const use: OpenRouterKeyUse = body?.use === "own" || body?.use === "outrunner" ? body.use : "auto";
  try {
    const key = await outrunnerModelKey(owner.id, use);
    return NextResponse.json({ key }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof OutrunnerModelsUnavailableError || error instanceof StoredKeyUnreadableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    // Nothing to retry: the user has to change something (their messages say what).
    if (error instanceof NoOwnOpenRouterKeyError || error instanceof ModelKeyRefusedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // OpenRouter's and the driver's messages stay in the log.
    console.error(`Could not get a key for Outrunner's models for ${owner.id}`, error);
    return NextResponse.json({ error: "Outrunner's models are unavailable right now. Please try again." }, { status: 502 });
  }
}
