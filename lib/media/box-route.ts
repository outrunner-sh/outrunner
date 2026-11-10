/**
 * The HTTP side of a box's upload routes (app/api/runtime/media): read the
 * signed request, answer it with one step of lib/media/box-uploads.ts.
 */

import { NextResponse } from "next/server";

import { readCappedBody } from "@/lib/http/capped-body";
import { type Answer, type BoxRequest, type BoxUploadDeps, MAX_BODY_BYTES } from "@/lib/media/box-uploads";
import { boxUploadDeps } from "@/lib/media/box-uploads.deps";

export async function answerBox(
  request: Request,
  step: (deps: BoxUploadDeps, request: BoxRequest) => Promise<Answer>,
): Promise<NextResponse> {
  // Read no further than a box's request goes: anyone can post here.
  const body = await readCappedBody(request, MAX_BODY_BYTES);
  if (body === null) return NextResponse.json({ error: "Not a box's request." }, { status: 400 });
  const boxRequest: BoxRequest = {
    sandboxId: request.headers.get("x-outrunner-sandbox"),
    timestamp: request.headers.get("x-outrunner-timestamp"),
    signature: request.headers.get("x-outrunner-signature"),
    body,
  };
  try {
    const { status, body } = await step(boxUploadDeps(new URL(request.url).origin), boxRequest);
    return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error(`Media upload from box ${boxRequest.sandboxId} failed`, error);
    return NextResponse.json({ error: "Outrunner couldn't take the upload. Try again." }, { status: 500 });
  }
}
