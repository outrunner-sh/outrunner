import { NextResponse } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import {
  enqueuePullRequest,
  getMergeAccess,
  getPullRequestStatusWithDetails,
  GitHubSyncError,
  type MergeAccess,
  mergePullRequest,
} from "@/lib/github/client";
import { requireGithubToken } from "@/lib/github/token";
import { type MergeAction, refuseMerge } from "@/lib/review/merge-plan";
import { readableRepo } from "@/lib/review/pulls";
import { triageCaller } from "@/lib/triage/caller";

const ACTIONS: ReadonlySet<MergeAction> = new Set(["merge", "queue", "bypass"]);

/**
 * Merge from the Review tab, as the person clicking: with their own GitHub
 * connection (the App's user token, lib/github/personal.ts), never the App's
 * installation, so GitHub holds them to their own access and names them as
 * who merged. At the commit they saw: GitHub refuses one that
 * moved since.
 *
 *   merge   by the branch's rules, only once the PR passes them;
 *   queue   into the base branch's merge queue, when it has one;
 *   bypass  past the rules, only for someone GitHub lets past them.
 *
 * Which one is decided again here from what GitHub says now
 * (lib/review/merge-plan.ts): an admin's plain Merge would otherwise bypass
 * the rules without their asking.
 */
export async function POST(request: Request) {
  const caller = await triageCaller(request);
  if (caller instanceof NextResponse) return caller;
  const body = (await request.json().catch(() => null)) as { repo?: unknown; number?: unknown; headSha?: unknown; action?: unknown } | null;
  const action = (body?.action ?? "merge") as MergeAction;
  if (typeof body?.repo !== "string" || typeof body.number !== "number" || typeof body.headSha !== "string" || !ACTIONS.has(action)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const repo = await readableRepo(caller.actor, body.repo);
  if (!repo) return NextResponse.json({ error: "Pull request not found." }, { status: 404 });
  let token: string;
  try {
    token = await requireGithubToken(caller.owner.id);
  } catch {
    return NextResponse.json(
      { error: "Connect GitHub in Settings → Connections to merge.", reconnect: true, settingsHref: "/settings/connections" },
      { status: 409 },
    );
  }
  const pull = { token, repoFullName: repo.fullName, number: body.number };
  try {
    const { status, details } = await getPullRequestStatusWithDetails(pull);
    if (status.headSha !== body.headSha) {
      return NextResponse.json({ error: "New commits were pushed since you looked. Reload to see them." }, { status: 409 });
    }
    const access: MergeAccess | null = details.baseRef
      ? await getMergeAccess({ ...pull, baseRef: details.baseRef }).catch((error: unknown) => {
          console.error(`Review: couldn't read the merge rules of ${repo.fullName}#${body.number}`, error);
          return null;
        })
      : null;
    // Every merge goes by GitHub's word on this branch, never a guess: without
    // it, a branch's queue could be skipped, or an admin's plain Merge go
    // past the rules, so none goes out.
    if (!access) {
      return NextResponse.json({ error: "Couldn't read this branch's merge rules from GitHub. Please try again." }, { status: 502 });
    }
    const why = refuseMerge(action, status, access);
    if (why) return NextResponse.json({ error: why }, { status: 409 });

    if (action === "queue") {
      const { position } = await enqueuePullRequest({ token, pullId: access.pullId, headSha: body.headSha });
      return NextResponse.json({ queued: true, position });
    }
    await mergePullRequest({ ...pull, headSha: body.headSha, methods: access.methods });
    if (action === "bypass") {
      await recordAudit({
        orgId: caller.actor.orgId,
        actor: caller.owner,
        action: "github.rules_bypassed",
        resource: { type: "pull_request", id: `${repo.fullName}#${body.number}`, label: `${repo.fullName}#${body.number}` },
        details: { headSha: body.headSha, mergeableState: status.mergeableState, mergeQueue: access.mergeQueue },
      });
    }
    return NextResponse.json({ merged: true });
  } catch (error) {
    if (error instanceof GitHubSyncError) return NextResponse.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
