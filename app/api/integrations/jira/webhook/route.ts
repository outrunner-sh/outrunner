import { NextResponse } from "next/server";

import { optionalEnv } from "@/lib/env";
import { handleJiraEvent } from "@/lib/trackers/jira-events";
import { jiraEventDeps } from "@/lib/trackers/jira-events.deps";
import { MAX_BODY_BYTES, receiveJiraWebhook } from "@/lib/trackers/jira-webhook";

/** The Jira app's webhook (docs/jira-app.md): one per site, all arriving here. */
export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Too large." }, { status: 413 });
  }
  const receipt = await receiveJiraWebhook(
    {
      body: new Uint8Array(await request.arrayBuffer()),
      authorization: request.headers.get("authorization"),
      identifier: request.headers.get("x-atlassian-webhook-identifier"),
      secret: optionalEnv("JIRA_CLIENT_SECRET") ?? null,
    },
    (event) => handleJiraEvent(event, jiraEventDeps),
  );
  return NextResponse.json(receipt.body, { status: receipt.status });
}
