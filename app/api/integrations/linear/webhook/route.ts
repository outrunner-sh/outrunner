import { NextResponse } from "next/server";

import { optionalEnv } from "@/lib/env";
import { handleLinearEvent } from "@/lib/trackers/linear-events";
import { linearEventDeps } from "@/lib/trackers/linear-events.deps";
import { MAX_BODY_BYTES, receiveLinearWebhook } from "@/lib/trackers/linear-webhook";

/**
 * The Linear app's webhook (docs/linear-app.md). Read as bytes: the signature is
 * over the body exactly as it came.
 */
export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Too large." }, { status: 413 });
  }
  const receipt = await receiveLinearWebhook(
    {
      body: new Uint8Array(await request.arrayBuffer()),
      signature: request.headers.get("linear-signature"),
      deliveryId: request.headers.get("linear-delivery"),
      secret: optionalEnv("LINEAR_WEBHOOK_SECRET") ?? null,
    },
    (event) => handleLinearEvent(event, linearEventDeps),
  );
  return NextResponse.json(receipt.body, { status: receipt.status });
}
