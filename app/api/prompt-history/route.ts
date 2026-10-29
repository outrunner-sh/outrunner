import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { addPromptHistory, getPromptHistory } from "@/lib/db/prompt-history";
import { isSameOriginRequest } from "@/lib/http/guards";
import { recallable } from "@/lib/session/prompt-history";

/**
 * The signed-in user's prompt history, for the composer's recall (↑ and
 * Ctrl+R): GET their prompts, newest first, each once; POST one they just
 * sent. Across their sessions and devices, theirs alone.
 */
export async function GET() {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  try {
    // Whose they are, so a page that outlives a sign-out (the sign-in after
    // it is a client navigation) never offers one user's prompts to another.
    return NextResponse.json({ prompts: await getPromptHistory(owner.id), owner: owner.id });
  } catch (error) {
    console.warn("Prompt history: couldn't read it", error);
    return NextResponse.json({ error: "Couldn't read your prompts." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? recallable(body.text) : null;
  if (!text) return NextResponse.json({ error: "A prompt to keep is required." }, { status: 400 });
  try {
    await addPromptHistory(owner.id, text);
  } catch (error) {
    console.warn("Prompt history: couldn't keep a prompt", error);
    return NextResponse.json({ error: "Couldn't keep that prompt." }, { status: 502 });
  }
  return NextResponse.json({ result: "kept" });
}
