import { NextResponse } from "next/server";

import { databaseNotUpdated } from "@/lib/http/database-not-updated";

/** A settings route's answer to a request with no signed-in user. */
export function signInFirst(): NextResponse {
  return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
}

/**
 * Run a settings change, answering the database's refusal as JSON the page
 * can show (see {@link databaseNotUpdated}). `what` names the settings in the
 * server's log.
 */
export async function savingSettings(what: string, save: () => Promise<NextResponse>): Promise<Response> {
  try {
    return await save();
  } catch (error) {
    const notUpdated = databaseNotUpdated(error, what);
    if (notUpdated) return notUpdated;
    console.error(`Could not save ${what}`, error);
    return NextResponse.json({ error: "Couldn't save that. Try again." }, { status: 500 });
  }
}
