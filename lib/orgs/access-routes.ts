import { NextResponse } from "next/server";

import { AccessChangeError } from "@/lib/db/org-access";
import { databaseNotUpdated } from "@/lib/http/database-not-updated";

/** Run a change to an org's roles or grants, answering a refusal (a role
 *  name taken, a role of another org) as 409 with its reason. */
export async function changingAccess(what: string, change: () => Promise<Response>): Promise<Response> {
  try {
    return await change();
  } catch (error) {
    if (error instanceof AccessChangeError) return NextResponse.json({ error: error.message }, { status: 409 });
    const notUpdated = databaseNotUpdated(error, what);
    if (notUpdated) return notUpdated;
    console.error(`Could not change ${what}`, error);
    return NextResponse.json({ error: "Couldn't make that change. Try again." }, { status: 500 });
  }
}
