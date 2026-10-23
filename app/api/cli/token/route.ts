import { NextResponse } from "next/server";

import { bearerToken, exchangeCliLoginCode, hashSecret } from "@/lib/auth/cli-login";
import { isOwner, ownerFromUser } from "@/lib/auth/owner";
import { revokeCliToken, saveCliToken, takeLoginCode } from "@/lib/db/cli-tokens";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * The CLI's side of signing in. POST trades the one-time code /cli-login
 * handed it, and its PKCE verifier, for a token (lib/auth/cli-login.ts).
 * DELETE (`outrunner logout`) stops the token in the request working.
 *
 * No Origin check: these are the CLI's, which no browser sends on its own.
 */

export async function POST(request: Request) {
  let body: { code?: unknown; verifier?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  try {
    const result = await exchangeCliLoginCode(body, { takeCode: takeLoginCode, saveToken: saveCliToken });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

    const { data } = await createSupabaseAdminClient().auth.admin.getUserById(result.userId);
    if (!data.user || !isOwner(data.user)) {
      await revokeCliToken(hashSecret(result.token));
      return NextResponse.json({ error: "That account can't sign in here." }, { status: 403 });
    }
    const owner = ownerFromUser(data.user);
    return NextResponse.json({
      token: result.token,
      user: { login: owner.githubLogin, name: owner.name, email: owner.email },
    });
  } catch (error) {
    console.error("Could not sign the CLI in", error);
    return NextResponse.json({ error: "Outrunner couldn't sign the CLI in. Try again." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const token = bearerToken(request.headers);
  if (!token) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  await revokeCliToken(hashSecret(token));
  return new NextResponse(null, { status: 204 });
}
