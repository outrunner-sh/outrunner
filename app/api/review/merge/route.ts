import { NextResponse } from "next/server";

import { GitHubSyncError, mergePullRequest } from "@/lib/github/client";
import { requireGithubToken } from "@/lib/github/token";
import { readableRepo } from "@/lib/review/pulls";
import { triageCaller } from "@/lib/triage/caller";

/**
 * Merge from the Review tab, as the person clicking (their own GitHub
 * account, as Replicas' merge button does), at the commit they saw: GitHub
 * refuses one that moved since, or that their access doesn't allow.
 */
export async function POST(request: Request) {
  const caller = await triageCaller(request);
  if (caller instanceof NextResponse) return caller;
  const body = (await request.json().catch(() => null)) as { repo?: unknown; number?: unknown; headSha?: unknown } | null;
  if (typeof body?.repo !== "string" || typeof body.number !== "number" || typeof body.headSha !== "string") {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const repo = await readableRepo(caller.actor, body.repo);
  if (!repo) return NextResponse.json({ error: "Pull request not found." }, { status: 404 });
  let token: string;
  try {
    token = await requireGithubToken(caller.owner.id);
  } catch {
    return NextResponse.json({ error: "Connect your GitHub account to merge (sign out and in again)." }, { status: 409 });
  }
  try {
    await mergePullRequest({ token, repoFullName: repo.fullName, number: body.number, headSha: body.headSha });
    return NextResponse.json({ merged: true });
  } catch (error) {
    if (error instanceof GitHubSyncError) return NextResponse.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
