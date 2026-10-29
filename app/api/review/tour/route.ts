import { NextResponse } from "next/server";

import { orgModelKey } from "@/lib/db/slack-agent";
import { ModelKeyRefusedError, OutrunnerModelsUnavailableError } from "@/lib/openrouter/keys";
import { pullDetail } from "@/lib/review/pulls";
import { writeTour } from "@/lib/review/tour";
import { triageCaller } from "@/lib/triage/caller";

/** A long PR's tour is written for up to 7 minutes (tourTimeoutMs). */
export const maxDuration = 480;

/** "Start tour": a guided walk through a PR's diff, written by Outrunner's
 *  model on the org's budget. Only for a PR the asker may read. */
export async function POST(request: Request) {
  const caller = await triageCaller(request);
  if (caller instanceof NextResponse) return caller;
  const body = (await request.json().catch(() => null)) as { repo?: unknown; number?: unknown } | null;
  if (typeof body?.repo !== "string" || typeof body.number !== "number") {
    return NextResponse.json({ error: "Say which pull request." }, { status: 400 });
  }
  const pr = await pullDetail(caller.actor, body.repo, body.number);
  if (!pr) return NextResponse.json({ error: "Pull request not found." }, { status: 404 });
  if (!pr.files) return NextResponse.json({ error: "GitHub didn't list this PR's files. Try again." }, { status: 502 });
  const files = pr.files;
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
    const tour = await writeTour(key, { title: pr.title, body: pr.body }, files, pr.filesComplete, request.signal);
    return NextResponse.json({ tour, headSha: pr.headSha });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error("Review: the tour failed", error);
    return NextResponse.json({ error: "Couldn't write the tour. Please try again." }, { status: 502 });
  }
}
