import { connection, NextResponse } from "next/server";

import { signInProvider } from "@/lib/auth/identity";
import { completeSignIn, redirectBase, signInError } from "@/lib/auth/complete-sign-in";
import { safeRelativePath } from "@/lib/auth/redirect";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * OAuth callback, for GitHub and Google sign-in alike, and for connecting
 * GitHub to an account that signed in with Google (`linkIdentity`).
 *
 * The browser starts the PKCE flow with `signInWithOAuth` (or
 * `linkIdentity`); the provider (via Supabase) redirects back here with a
 * `code`. We exchange it for a session
 * — which sets the auth cookies on this response — then finish as every
 * sign-in does (lib/auth/complete-sign-in.ts): the allowlist first.
 */
export async function GET(request: Request) {
  // Per request, never prerendered at build (Cache Components prerenders a
  // GET that reads nothing of the request first).
  await connection();
  const requestUrl = new URL(request.url);
  const base = redirectBase(requestUrl);
  const next = safeRelativePath(requestUrl.searchParams.get("next"));

  // The provider/Supabase can bounce back with an error instead of a code
  // (user cancelled, provider misconfigured).
  const providerError =
    requestUrl.searchParams.get("error_description") ??
    requestUrl.searchParams.get("error");
  if (providerError) return NextResponse.redirect(signInError(base, providerError));

  const code = requestUrl.searchParams.get("code");
  if (!code) return NextResponse.redirect(signInError(base, "missing_code"));

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    return NextResponse.redirect(signInError(base, error?.message ?? "exchange_failed"));
  }

  // The session's provider_token is the token of the provider just used: a
  // GitHub token only when this round trip went through GitHub.
  const githubToken =
    signInProvider(data.user) === "github" ? (data.session?.provider_token ?? undefined) : undefined;

  return NextResponse.redirect(await completeSignIn({ supabase, user: data.user, githubToken, base, next }));
}
