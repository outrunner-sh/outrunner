import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { modelMenu, offersModels } from "@/lib/db/credentials";
import { getModelLoadout } from "@/lib/db/model-loadout";

export const dynamic = "force-dynamic";

/**
 * What the user's model menu offers (lib/runtime/session-models.ts): whether
 * the server runs Outrunner's models and on an allowance, and which providers
 * the user has a key for. Never a key itself. `available`: whether a session
 * can start without the user's Claude (a cloud session, or one on a Mac whose
 * Claude Code isn't logged in). `loadout`: the models the picker shows first,
 * and the one a new session starts on (Settings → Default models). `ownKey`
 * and `serverModels` are for pages loaded before providers; kept for one
 * release.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const [menu, loadout] = await Promise.all([modelMenu(owner.id), getModelLoadout(owner.id)]);
  return NextResponse.json({
    ...menu,
    loadout,
    available: offersModels(menu),
    ownKey: menu.keys.includes("openrouter"),
    serverModels: menu.outrunner,
  });
}
