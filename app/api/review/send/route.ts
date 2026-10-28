import { NextResponse } from "next/server";

import { pullDetail } from "@/lib/review/pulls";
import { wakeAndSend } from "@/lib/slack/research";
import { triageCaller } from "@/lib/triage/caller";

/** "Needs changes": a request from the Review tab, sent to the session that
 *  opened the PR (woken first). Only its owner's: a session is theirs alone. */
export async function POST(request: Request) {
  const caller = await triageCaller(request);
  if (caller instanceof NextResponse) return caller;
  const body = (await request.json().catch(() => null)) as { repo?: unknown; number?: unknown; message?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (typeof body?.repo !== "string" || typeof body.number !== "number" || !message) {
    return NextResponse.json({ error: "Say what needs changing." }, { status: 400 });
  }
  const pr = await pullDetail(caller.actor, body.repo, body.number);
  if (!pr) return NextResponse.json({ error: "Pull request not found." }, { status: 404 });
  if (!pr.sessionId || !pr.ownSession) {
    return NextResponse.json({ error: "Only the person whose session opened this PR can send it work." }, { status: 403 });
  }
  const prompt = `Review feedback on your pull request #${pr.number} (${pr.url}):\n\n${message.slice(0, 8000)}\n\nMake the changes, push to the same branch, and say what you changed.`;
  const sent = await wakeAndSend(caller.owner.id, pr.sessionId, prompt).catch(() => false);
  if (!sent) return NextResponse.json({ error: "Couldn't reach the session. Open it and try from there." }, { status: 502 });
  return NextResponse.json({ sent: true, sessionId: pr.sessionId });
}
