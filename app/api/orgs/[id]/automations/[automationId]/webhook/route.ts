import { NextResponse } from "next/server";

import { rotateWebhookToken } from "@/lib/db/automation-webhooks";
import { databaseNotUpdated } from "@/lib/http/database-not-updated";
import { isUuid } from "@/lib/ids";
import { orgCaller } from "@/lib/orgs/routes";

type Params = { params: Promise<{ id: string; automationId: string }> };

/** Give an automation a new webhook URL: the org's admins may. The old one
 *  stops working at once; the new path is answered, for the editor to show. */
export async function POST(request: Request, { params }: Params) {
  const { id, automationId } = await params;
  const caller = await orgCaller(request, id, { admin: true });
  if (caller instanceof Response) return caller;
  if (!isUuid(automationId)) return NextResponse.json({ error: "No such automation." }, { status: 404 });
  try {
    const path = await rotateWebhookToken(id, automationId);
    if (!path) return NextResponse.json({ error: "No such automation." }, { status: 404 });
    return NextResponse.json({ path });
  } catch (error) {
    const notUpdated = databaseNotUpdated(error, "the webhook");
    if (notUpdated) return notUpdated;
    console.error(`Couldn't rotate automation ${automationId}'s webhook`, error);
    return NextResponse.json({ error: "Couldn't make a new URL. Try again." }, { status: 500 });
  }
}
