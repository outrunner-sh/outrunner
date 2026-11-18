import { NextResponse } from "next/server";

import { CoverNewReposTriggersError, ForeignRepoError, NoReviewersError } from "@/lib/db/automations";
import { databaseNotUpdated } from "@/lib/http/database-not-updated";

/** Run a change to an automation, answering a repository that isn't the
 *  org's, review requests of no one, or covering new repositories on a
 *  schedule or webhook, as 400; a database without the
 *  migration as 503; and anything else as 500. */
export async function savingAutomation(
  save: () => Promise<Response>,
  what: "save" | "delete" = "save",
): Promise<Response> {
  try {
    return await save();
  } catch (error) {
    if (error instanceof ForeignRepoError || error instanceof NoReviewersError || error instanceof CoverNewReposTriggersError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const notUpdated = databaseNotUpdated(error, "the automation");
    if (notUpdated) return notUpdated;
    console.error(`Could not ${what} an automation`, error);
    return NextResponse.json({ error: `Couldn't ${what} the automation. Try again.` }, { status: 500 });
  }
}
