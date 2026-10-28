import { NextResponse } from "next/server";

import { orgModelKey } from "@/lib/db/slack-agent";
import { ModelKeyRefusedError, OutrunnerModelsUnavailableError } from "@/lib/openrouter/keys";
import { askAboutPull, type AskMessage } from "@/lib/review/ask";
import { pullDetail } from "@/lib/review/pulls";
import { repoToken } from "@/lib/slack/github";
import { triageCaller } from "@/lib/triage/caller";

/** "Ask about this PR": the conversation so far in, an answer from the code
 *  out, on the org's model budget. Only for a PR the asker may read. */
export async function POST(request: Request) {
  const caller = await triageCaller(request);
  if (caller instanceof NextResponse) return caller;
  const body = (await request.json().catch(() => null)) as { repo?: unknown; number?: unknown; messages?: unknown } | null;
  const messages = Array.isArray(body?.messages)
    ? (body.messages as AskMessage[]).filter(
        (m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim(),
      )
    : [];
  if (typeof body?.repo !== "string" || typeof body.number !== "number" || messages.at(-1)?.role !== "user") {
    return NextResponse.json({ error: "Ask a question about a pull request." }, { status: 400 });
  }
  const pr = await pullDetail(caller.actor, body.repo, body.number);
  const token = pr ? await repoToken(caller.actor.orgId, pr.repo) : null;
  if (!pr || !token) return NextResponse.json({ error: "Pull request not found." }, { status: 404 });
  let key: string;
  try {
    key = await orgModelKey(caller.actor.orgId);
  } catch (error) {
    if (error instanceof ModelKeyRefusedError || error instanceof OutrunnerModelsUnavailableError) {
      return NextResponse.json({ error: "The org's model budget is used up, or Outrunner's models aren't set up." }, { status: 409 });
    }
    throw error;
  }
  try {
    const answer = await askAboutPull(
      key,
      { token, repo: pr.repo, number: pr.number, title: pr.title, body: pr.body, headSha: pr.headSha, baseRef: pr.baseRef, headRef: pr.headRef },
      messages.map((m) => ({ role: m.role, content: m.content.slice(0, 8000) })),
    );
    return NextResponse.json({ answer });
  } catch (error) {
    console.error("Review: the question failed", error);
    return NextResponse.json({ error: "Couldn't answer that. Please try again." }, { status: 502 });
  }
}
