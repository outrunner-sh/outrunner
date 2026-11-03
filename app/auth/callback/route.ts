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
  if (providerError) {
    // Signed in already: this was connecting GitHub (`linkIdentity`) that
    // failed — most often, that GitHub account already belongs to another
    // Outrunner account. /signin would bounce them home and lose why, so go
    // back where they started, saying so (Settings → Account reads it).
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
    if (data.user) {
      const back = new URL(`${base}${next}`);
      // Fields, not text: the error is the URL's, anyone's to write.
      console.warn(`Connecting a provider failed for ${data.user.id}`, {
        error_code: requestUrl.searchParams.get("error_code"),
        error: providerError,
      });
      back.searchParams.set("link_error", requestUrl.searchParams.get("error_code") ?? "link_failed");
      return NextResponse.redirect(back);
    }
    return NextResponse.redirect(signInError(base, providerError));
  }

  const code = requestUrl.searchParams.get("code");
  if (!code) return NextResponse.redirect(signInError(base, "missing_code"));

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    return NextResponse.redirect(signInError(base, error?.message ?? "exchange_failed"));
  }

  // Reconnecting GitHub (components/signin-button.tsx reconnectGithub) signs
  // in with it again, as whichever GitHub account the browser is signed in
  // to. Another one than the user's linked account is another Outrunner
  // user (or a new one): that session is ended and its token not stored,
  // rather than the user quietly finding themselves someone else.
  const reconnectAs = requestUrl.searchParams.get("reconnect_as");
  if (reconnectAs && data.user.id !== reconnectAs) {
    console.warn(`Reconnecting GitHub for ${reconnectAs} came back as ${data.user.id}; signing that session out`);
    await supabase.auth.signOut();
    return NextResponse.redirect(signInError(base, "reconnect_other_account"));
  }

  // The session's provider_token is the token of the provider just used: a
  // GitHub token only when this round trip went through GitHub.
  const githubToken =
    signInProvider(data.user) === "github" ? (data.session?.provider_token ?? undefined) : undefined;

  return NextResponse.redirect(await completeSignIn({ supabase, user: data.user, githubToken, base, next }));
}
