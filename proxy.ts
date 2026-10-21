import { createServerClient } from "@supabase/ssr";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { isShellPrefetch, signInRedirect, type SignedIn } from "@/lib/auth/sign-in-redirect";

/**
 * Session refresh and the sign-in gate (Next.js 16 renamed `middleware` to
 * `proxy`).
 *
 * Supabase access tokens expire hourly. Without a refresh here, Server
 * Components see an expired token and treat the owner as signed out even while
 * the browser still looks logged in.
 *
 * A signed-out page load goes to sign-in from here (lib/auth/sign-in-redirect.ts)
 * rather than from each page, so pages don't each have to ask the server first.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  if (isShellPrefetch(request.headers)) return response;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Before Supabase is configured the app still needs to boot and render.
  if (!url || !key) return response;

  try {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    });

    // Touching getClaims() is what performs the refresh; do not remove. With
    // asymmetric JWT signing keys it verifies the token here, without a call
    // to Supabase Auth (getUser() always made one). Who the user is, for
    // anything that matters, is still getUser()'s job (lib/auth/owner.ts).
    const { data, error } = await supabase.auth.getClaims();
    const signedIn: SignedIn = data?.claims ? true : error && isAuthRetryableFetchError(error) ? "unknown" : false;
    const to = signInRedirect({
      method: request.method,
      pathname: request.nextUrl.pathname,
      search: request.nextUrl.search,
      signedIn,
    });
    if (to) return withCookies(NextResponse.redirect(new URL(to, request.url)), response);
  } catch (error) {
    // Configuration diagnostics must remain reachable if the URL/key is bad.
    console.error("Supabase session refresh was skipped", error);
  }

  return response;
}

/** A redirect carrying the cookies the refresh set (a cleared session, say). */
function withCookies(redirect: NextResponse, from: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) redirect.cookies.set(cookie);
  return redirect;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
