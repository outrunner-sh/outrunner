import { NextResponse } from "next/server";

import { isUuid } from "@/lib/ids";
import { answerResearch } from "@/lib/slack/research";

type RouteContext = { params: Promise<{ id: string }> };

/** An answer is a few hundred words; nothing near this. */
const MAX_ANSWER_BYTES = 64 * 1024;

/**
 * Where a Slack thread's research session posts its answer (the link its
 * prompt carried, lib/slack/research.ts): `Authorization: Bearer <token>`,
 * the answer as the body. Good once; posted in the thread.
 */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const token = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get("authorization")?.trim() ?? "")?.[1];
  if (!isUuid(id) || !token) return NextResponse.json({ error: "Not a research link." }, { status: 404 });
  const answer = await request.text();
  if (Buffer.byteLength(answer) > MAX_ANSWER_BYTES) return NextResponse.json({ error: "Too long." }, { status: 413 });
  if (!answer.trim()) return NextResponse.json({ error: "The answer is empty." }, { status: 400 });
  if (!(await answerResearch(id, token, answer))) {
    return NextResponse.json({ error: "This link isn't valid, or was used." }, { status: 404 });
  }
  return NextResponse.json({ posted: true });
}
