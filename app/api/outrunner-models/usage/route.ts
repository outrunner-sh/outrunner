import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { outrunnerModelAllowance } from "@/lib/db/credentials";
import { allowanceView } from "@/lib/openrouter/allowance";

export const dynamic = "force-dynamic";

/**
 * How much the signed-in user has used of their allowance on Outrunner's
 * models (`allowance`: a percentage and its state, never dollars), for the
 * sidebar's bar; null where there's no per-user allowance. Read from
 * OpenRouter on each call.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  try {
    const allowance = await outrunnerModelAllowance(owner.id);
    return NextResponse.json({ allowance: allowance && allowanceView(allowance) });
  } catch (error) {
    console.error("Could not read a user's Outrunner allowance", error);
    return NextResponse.json({ error: "Couldn't read your usage right now." }, { status: 502 });
  }
}
