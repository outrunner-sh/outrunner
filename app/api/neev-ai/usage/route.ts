import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { neevAiAllowance } from "@/lib/db/credentials";

export const dynamic = "force-dynamic";

/**
 * What the signed-in user has spent of their allowance on Outrunner's models
 * (`allowance`: used and limit, in USD), for the sidebar's bar; null where
 * there's no per-user allowance. Read from OpenRouter on each call.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  try {
    return NextResponse.json({ allowance: await neevAiAllowance(owner.id) });
  } catch (error) {
    console.error("Could not read a user's Outrunner allowance", error);
    return NextResponse.json({ error: "Couldn't read your usage right now." }, { status: 502 });
  }
}
