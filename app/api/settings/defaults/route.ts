import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { getSessionDefaults, saveSessionDefaults } from "@/lib/runtime/session-defaults-server";

export const dynamic = "force-dynamic";

/** What new sessions start on: GET reads it, PUT saves it (Settings → Models). */
export async function GET() {
  if (!(await getOwner())) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  return NextResponse.json(await getSessionDefaults());
}

export async function PUT(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  if (!(await getOwner())) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json(await saveSessionDefaults(body));
  } catch (error) {
    console.error("Could not save session defaults", error);
    return NextResponse.json({ error: "Could not save that. Please try again." }, { status: 500 });
  }
}
