import { NextResponse } from "next/server";

import { forgetInstallation, updateInstallation } from "@/lib/db/github-installations";
import { githubAppConfig, isGitHubSignature } from "@/lib/github/app";
import { handleAppEvent } from "@/lib/github/app-events";
import { readCappedBody } from "@/lib/http/capped-body";

/** GitHub caps a delivery at 25 MB; a review event is far smaller. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * The Outrunner GitHub App's webhook. Trusts nothing but the signature,
 * checked on the raw body with GITHUB_APP_WEBHOOK_SECRET; then keeps the
 * linked installations true to GitHub (lib/github/app-events.ts). A 5xx asks
 * GitHub to deliver again.
 */
export async function POST(request: Request) {
  const config = githubAppConfig();
  if (!config) {
    return NextResponse.json({ error: "The GitHub App isn't set up on this server." }, { status: 503 });
  }
  const body = await readCappedBody(request, MAX_BODY_BYTES);
  if (body === null) return NextResponse.json({ error: "Too large." }, { status: 413 });
  if (!isGitHubSignature(config.webhookSecret, body, request.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "Invalid GitHub signature." }, { status: 401 });
  }

  const event = request.headers.get("x-github-event") ?? "";
  const delivery = request.headers.get("x-github-delivery") ?? "unknown";
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Not JSON." }, { status: 400 });
  }
  try {
    const outcome = await handleAppEvent(event, payload, { forgetInstallation, updateInstallation });
    return NextResponse.json({ received: true, outcome });
  } catch (error) {
    console.error(`GitHub App delivery ${delivery} (${event}) failed; GitHub may deliver it again`, error);
    return NextResponse.json({ error: "Could not handle the event." }, { status: 500 });
  }
}
