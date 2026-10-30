import { NextResponse } from "next/server";

import { redirectBase } from "@/lib/auth/complete-sign-in";
import { DESKTOP_CONTEXT_COOKIE, DESKTOP_CONTEXT_SECONDS, desktopContext, sealDesktopContext } from "@/lib/auth/desktop/grant";

/** Opened by the native shell in the SYSTEM browser, before any OAuth/OTP. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const base = redirectBase(url);
  const context = desktopContext(url.searchParams.get("state"), url.searchParams.get("challenge"), url.searchParams.get("next"));
  if (!context) return new NextResponse("Invalid desktop sign-in. Start again from the app.", { status: 400 });
  const response = NextResponse.redirect(`${base}/auth/desktop/ready`);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set(DESKTOP_CONTEXT_COOKIE, sealDesktopContext(context), {
    httpOnly: true, sameSite: "lax", secure: base.startsWith("https:"), path: "/", maxAge: DESKTOP_CONTEXT_SECONDS,
  });
  return response;
}
