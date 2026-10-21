import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getModelLoadout, setModelLoadout } from "@/lib/db/model-loadout";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";
import { parseLoadout } from "@/lib/runtime/model-loadout";

/**
 * The user's model loadout (Settings → Default models): GET reads it, PUT
 * `{ models, default }` replaces it. What isn't a menu choice is dropped on
 * the way in (lib/runtime/model-loadout.ts parseLoadout), so the answer is
 * what was kept.
 */

export async function GET() {
  const owner = await getOwner();
  if (!owner) return signInFirst();
  return savingSettings("model loadout", async () => NextResponse.json(await getModelLoadout(owner.id)));
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const body: unknown = await request.json().catch(() => null);
  return savingSettings("model loadout", async () =>
    NextResponse.json(await setModelLoadout(owner.id, parseLoadout(body))),
  );
}
