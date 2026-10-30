import { NextResponse } from "next/server";

import { redirectBase } from "@/lib/auth/complete-sign-in";
import { DESKTOP_CONTEXT_COOKIE, desktopDestination } from "@/lib/auth/desktop/grant";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const response = NextResponse.redirect(`${redirectBase(url)}${desktopDestination(url.searchParams.get("next"))}`);
  response.cookies.delete(DESKTOP_CONTEXT_COOKIE);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
