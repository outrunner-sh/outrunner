import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { clearOpenRouterKey, getOpenRouterKeyStatus, setOpenRouterKey } from "@/lib/db/credentials";
import { isSameOriginRequest } from "@/lib/http/guards";
import { keySource, openRouterAcceptsKey } from "@/lib/openrouter/keys";
import { probeStatus } from "@/lib/supabase/probe";

export const dynamic = "force-dynamic";

/**
 * The user's own model provider keys (Settings → Providers): for now their
 * OpenRouter key, which Outrunner's models then run on instead of the
 * server's. GET says whether one is saved (its last 4 characters, never the
 * key) and whether the server has a key of its own to fall back on. PUT
 * stores a key OpenRouter has accepted; DELETE forgets it.
 */

/** OpenRouter's keys: `sk-or-v1-` and 64 hex characters, give or take. */
const OPENROUTER_KEY = /^sk-or-[A-Za-z0-9-]{20,200}$/;

async function providers(userId: string) {
  return { openrouter: await getOpenRouterKeyStatus(userId), serverModels: keySource() !== null };
}

function unauthorized() {
  return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
}

/** Run a change, answering the database's refusal as JSON the page can show. */
async function changing(change: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await change();
  } catch (error) {
    // Until the migration is applied, the key's columns aren't there.
    if (probeStatus(error as { code?: string }) === "outdated") {
      return NextResponse.json(
        { error: "This can't be saved until Outrunner's database is updated. Try again later." },
        { status: 503 },
      );
    }
    console.error("Could not save provider settings", error);
    return NextResponse.json({ error: "Couldn't save that. Try again." }, { status: 500 });
  }
}

export async function GET() {
  const owner = await getOwner();
  if (!owner) return unauthorized();
  return changing(async () => NextResponse.json(await providers(owner.id)));
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return unauthorized();

  const body = (await request.json().catch(() => null)) as { openrouterKey?: unknown } | null;
  const key = typeof body?.openrouterKey === "string" ? body.openrouterKey.trim() : "";
  if (!OPENROUTER_KEY.test(key)) {
    return NextResponse.json(
      { error: "That doesn't look like an OpenRouter API key (sk-or-…). Copy one from OpenRouter → Keys." },
      { status: 400 },
    );
  }
  let accepted: boolean;
  try {
    accepted = await openRouterAcceptsKey(key);
  } catch (error) {
    console.error("Could not check an OpenRouter key", error);
    return NextResponse.json(
      { error: "Couldn't reach OpenRouter to check that key. Try again in a moment." },
      { status: 502 },
    );
  }
  if (!accepted) {
    return NextResponse.json(
      { error: "OpenRouter didn't accept that as an API key. Use a key from OpenRouter → Keys, not a management key." },
      { status: 400 },
    );
  }
  return changing(async () => {
    await setOpenRouterKey(owner.id, key);
    return NextResponse.json(await providers(owner.id));
  });
}

export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return unauthorized();
  return changing(async () => {
    await clearOpenRouterKey(owner.id);
    return NextResponse.json(await providers(owner.id));
  });
}
