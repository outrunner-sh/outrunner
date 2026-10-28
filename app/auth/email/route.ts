import { NextResponse } from "next/server";

import { completeSignIn, redirectBase } from "@/lib/auth/complete-sign-in";
import { safeRelativePath } from "@/lib/auth/redirect";
import { isSameOriginRequest } from "@/lib/http/guards";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Sign in with the code emailed to `{ email }`: `{ email, token, next }`.
 *
 * The browser asks Supabase to send the code (`signInWithOtp`); checking it
 * happens here, so the session it makes goes through what every sign-in does
 * (lib/auth/complete-sign-in.ts) — the allowlist, an org's admission — before
 * anyone is let in, exactly as an OAuth sign-in at /auth/callback.
 *
 * Answers `{ redirect }`, where to go now (the app, or /signin saying why
 * not), or 400 `{ error }` for a wrong or expired code, so the form can let
 * them try again without asking for a new one.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as
    | { email?: unknown; token?: unknown; next?: unknown }
    | null;
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const token = typeof body?.token === "string" ? body.token.replace(/\s/g, "") : "";
  if (!email || !/^\d{6,10}$/.test(token)) {
    return NextResponse.json({ error: "Enter the code from the email." }, { status: 400 });
  }
  const next = safeRelativePath(typeof body?.next === "string" ? body.next : null);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error || !data.user) {
    // Supabase's limits are tight on its own mail sender: say so, rather than
    // send them back to retry a code that may be right.
    if (error?.status === 429 || error?.code === "over_request_rate_limit") {
      return NextResponse.json({ error: "Too many attempts. Wait a minute and try again." }, { status: 429 });
    }
    // Anything but the code's own fault is worth seeing in the log.
    if (error && (error.status === undefined || error.status >= 500)) {
      console.error("Couldn't check an emailed sign-in code", error);
    }
    return NextResponse.json(
      { error: "That code is wrong or has expired. Check it, or send a new one." },
      { status: 400 },
    );
  }

  const base = redirectBase(new URL(request.url));
  // An emailed code produces no GitHub token: connecting GitHub is Settings → Account's.
  return NextResponse.json({
    redirect: await completeSignIn({ supabase, user: data.user, githubToken: undefined, base, next }),
  });
}
