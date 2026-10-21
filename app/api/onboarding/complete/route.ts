import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { markOnboarded } from "@/lib/onboarding/server";

/** Onboarding is done: the first session started, or the user skipped it. */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  if (!(await getOwner())) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  try {
    await markOnboarded();
  } catch (error) {
    console.error("Could not mark onboarding complete", error);
    return NextResponse.json({ error: "Could not save that. Please try again." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
