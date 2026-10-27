import { NextResponse } from "next/server";

import { ForeignRepoError } from "@/lib/db/automations";
import { databaseNotUpdated } from "@/lib/http/database-not-updated";

/** Run a change to an automation, answering a repository that isn't the
 *  org's as 400, a database without the migration as 503, and anything else
 *  as 500. */
export async function savingAutomation(save: () => Promise<Response>): Promise<Response> {
  try {
    return await save();
  } catch (error) {
    if (error instanceof ForeignRepoError) return NextResponse.json({ error: error.message }, { status: 400 });
    const notUpdated = databaseNotUpdated(error, "the automation");
    if (notUpdated) return notUpdated;
    console.error("Could not save an automation", error);
    return NextResponse.json({ error: "Couldn't save the automation. Try again." }, { status: 500 });
  }
}
