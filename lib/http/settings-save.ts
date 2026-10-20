import { NextResponse } from "next/server";

import { probeStatus } from "@/lib/supabase/probe";

/** A settings route's answer to a request with no signed-in user. */
export function signInFirst(): NextResponse {
  return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
}

/**
 * Run a settings change, answering the database's refusal as JSON the page
 * can show. Until a migration is applied, its table or columns aren't there:
 * that is the database's to fix, not the user's. `what` names the settings in
 * the server's log.
 */
export async function savingSettings(what: string, save: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await save();
  } catch (error) {
    const status = probeStatus(error as { code?: string });
    if (status === "outdated" || status === "missing") {
      return NextResponse.json(
        { error: "This can't be saved until Outrunner's database is updated. Try again later." },
        { status: 503 },
      );
    }
    console.error(`Could not save ${what}`, error);
    return NextResponse.json({ error: "Couldn't save that. Try again." }, { status: 500 });
  }
}
