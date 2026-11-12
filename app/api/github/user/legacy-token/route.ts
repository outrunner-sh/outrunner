import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { removeLegacyToken } from "@/lib/github/legacy-token";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";

/**
 * Remove the user's old GitHub sign-in token (the `repo` one signing in used
 * to keep, lib/github/legacy-token.ts): revoked on GitHub where the OAuth
 * App's credentials are set, and forgotten here either way. Connecting
 * GitHub in Settings → Connections does this too.
 */
export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  return savingSettings("old GitHub token", async () => NextResponse.json(await removeLegacyToken(owner.id)));
}
