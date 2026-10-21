import type { Session, User } from "@supabase/supabase-js";
import { connection, NextResponse } from "next/server";

import { githubLogin, isOwner } from "@/lib/auth/owner";
import { safeRelativePath } from "@/lib/auth/redirect";
import { setGithubToken } from "@/lib/db/credentials";
import { optionalEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * GitHub OAuth callback.
 *
 * The browser starts the PKCE flow with `signInWithOAuth`; GitHub (via
 * Supabase) redirects back here with a `code`. We exchange it for a session
 * — which sets the auth cookies on this response — then enforce the
 * single-owner allowlist before letting anyone in.
 */
export async function GET(request: Request) {
  // Per request, never prerendered at build (Cache Components prerenders a
  // GET that reads nothing of the request first).
  await connection();
  const requestUrl = new URL(request.url);
  const base = redirectBase(request, requestUrl);
  const next = safeRelativePath(requestUrl.searchParams.get("next"));

  // GitHub/Supabase can bounce back with an error instead of a code
  // (user cancelled, provider misconfigured).
  const providerError =
    requestUrl.searchParams.get("error_description") ??
    requestUrl.searchParams.get("error");
  if (providerError) return signInError(base, providerError);

  const code = requestUrl.searchParams.get("code");
  if (!code) return signInError(base, "missing_code");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    return signInError(base, error?.message ?? "exchange_failed");
  }

  // Access is allowlisted: anyone whose GitHub login isn't in
  // RUNTIME_OWNER_GITHUB_LOGIN is signed straight back out. This is the whole
  // authorization model.
  if (!isOwner(data.user)) {
    await supabase.auth.signOut();
    return signInError(base, "not_owner");
  }

  await captureGithubToken(data);

  return NextResponse.redirect(`${base}${next}`);
}

/**
 * Persist the GitHub access token this sign-in produced.
 *
 * THIS IS THE ONLY PLACE IT IS AVAILABLE. Supabase surfaces `provider_token`
 * on the session returned by the code exchange and never stores or refreshes
 * it — `getSession()` later in the app returns nothing for it. Miss it here and
 * the user has to re-authenticate to get another one.
 *
 * Best-effort by design: a storage failure must not strand a user who has
 * otherwise signed in successfully. They land in the app with no GitHub
 * connection, which the UI already has to handle anyway (a first sign-in before
 * the `repo` scope was granted looks identical), and the next sign-in retries.
 */
async function captureGithubToken(
  data: { user: User | null; session: Session | null },
): Promise<void> {
  const token = data.session?.provider_token;
  const login = data.user ? githubLogin(data.user) : null;
  if (!token || !data.user || !login) return;

  try {
    await setGithubToken(data.user.id, token, login);
  } catch (err) {
    console.error(
      `Could not store the GitHub token for ${data.user.id}; ` +
        `sign-in continues without a GitHub connection.`,
      err,
    );
  }
}

/**
 * Absolute origin to redirect back to after the OAuth round trip.
 *
 * `RUNTIME_BASE_URL` is mandatory in production because a forwarded host is a
 * request header and therefore cannot be trusted for an authenticated
 * redirect. Local development may safely use the request origin.
 */
function redirectBase(_request: Request, requestUrl: URL): string {
  const configured = optionalEnv("RUNTIME_BASE_URL");
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("RUNTIME_BASE_URL must use http or https.");
    }
    return url.origin;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("RUNTIME_BASE_URL must be set in production.");
  }
  return requestUrl.origin;
}

function signInError(base: string, reason: string): NextResponse {
  const url = new URL(`${base}/signin`);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url);
}
