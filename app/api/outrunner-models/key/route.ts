import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getProviderKey, modelKey } from "@/lib/db/credentials";
import { isSameOriginRequest } from "@/lib/http/guards";
import { modelKeyErrorResponse } from "@/lib/http/model-key-errors";
import { isProviderId } from "@/lib/providers/registry";
import type { KeyHolder } from "@/lib/runtime/session-models";

/**
 * The key a model runs on, for `holder`: Outrunner's (created on first use),
 * or one of the user's own (Settings → Providers). A local session's page
 * needs it to put the session on the user's Mac on that model.
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
  const body = (await request.json().catch(() => null)) as { holder?: unknown; use?: unknown } | null;
  try {
    const holder = await keyHolder(owner.id, body);
    if (!holder) return NextResponse.json({ error: "Choose one of the providers." }, { status: 400 });
    const key = await modelKey(owner.id, holder);
    return NextResponse.json({ key }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return modelKeyErrorResponse(error, `Could not get a key for Outrunner's models for ${owner.id}`);
  }
}

/** Whose key: `holder`; or, from a page loaded before providers (kept for one
 *  release), `use`: their own OpenRouter key, Outrunner's, or (neither) theirs
 *  when they have one. */
async function keyHolder(
  userId: string,
  body: { holder?: unknown; use?: unknown } | null,
): Promise<KeyHolder | null> {
  if (body?.holder !== undefined) {
    return body.holder === "outrunner" || isProviderId(body.holder) ? body.holder : null;
  }
  if (body?.use === "own") return "openrouter";
  if (body?.use === "outrunner") return "outrunner";
  // Neither: theirs only if it opens (a saved one that doesn't, after the
  // encryption key changed, falls back to Outrunner's, as the menu does).
  return (await getProviderKey(userId, "openrouter")) ? "openrouter" : "outrunner";
}
