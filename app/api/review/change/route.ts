import { after, NextResponse } from "next/server";

import { linkedSessions, linkSession, resetCiTurns } from "@/lib/db/github-loop";
import { type LineQuote, requestChange, startSoon } from "@/lib/review/change";
import { commitsSince, pullHead, readReviewThreads } from "@/lib/review/pulls";
import { startServerSession } from "@/lib/session/server-session";
import { wakeAndSend } from "@/lib/slack/research";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { triageCaller } from "@/lib/triage/caller";

function readQuote(value: unknown): LineQuote | null {
  const q = (value ?? null) as Partial<LineQuote> | null;
  if (!q || typeof q.path !== "string" || !q.path || (q.side !== "new" && q.side !== "old") || typeof q.code !== "string") return null;
  if (!Number.isInteger(q.startLine) || !Number.isInteger(q.endLine) || (q.startLine as number) < 1 || (q.endLine as number) < (q.startLine as number)) {
    return null;
  }
  return { path: q.path, side: q.side, startLine: q.startLine as number, endLine: q.endLine as number, code: q.code.slice(0, 20_000) };
}

/**
 * "Ask for a change": what should change about the picked lines of a PR,
 * sent to the PR's session the asker may steer, or to a new session of
 * theirs on the PR's branch (lib/review/change.ts). Answers once the session
 * has it, or once a new one's row is made: its setup takes minutes, and goes
 * on after the answer.
 */
export async function POST(request: Request) {
  const caller = await triageCaller(request);
  if (caller instanceof NextResponse) return caller;
  const body = (await request.json().catch(() => null)) as { repo?: unknown; number?: unknown; message?: unknown; quote?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (typeof body?.repo !== "string" || typeof body.number !== "number" || !message) {
    return NextResponse.json({ error: "Say what should change." }, { status: 400 });
  }
  const head = await pullHead(caller.actor, body.repo, body.number);
  if (head.kind === "unavailable") return NextResponse.json({ error: "GitHub couldn't be reached. Try again." }, { status: 502 });
  if (head.kind === "unreadable") return NextResponse.json({ error: "Pull request not found." }, { status: 404 });
  const pr = head.pull;
  // This must precede review-thread reads and every session action. A push
  // to origin would update this repository's branch, not the fork's branch.
  if (pr.fromFork) {
    return NextResponse.json({ error: "This pull request's branch is in a fork, which Outrunner can't push to." }, { status: 409 });
  }
  if (pr.state !== "open") return NextResponse.json({ error: "This pull request isn't open." }, { status: 409 });
  const quote = readQuote(body.quote);
  // When it was asked, by the server's clock: the session's replies are
  // timed by it, and the page tells the change's reply by this.
  const askedAt = new Date().toISOString();
  const outcome = await requestChange(
    {
      pull: {
        repo: pr.repo,
        projectId: pr.projectId,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        headRef: pr.headRef,
        baseRef: pr.baseRef,
        fromFork: pr.fromFork,
      },
      userId: caller.owner.id,
      login: caller.owner.githubLogin || null,
      level: caller.actor.levels.get(pr.projectId) ?? null,
      orgId: caller.actor.orgId,
      message,
      quote,
    },
    {
      linkedSessions,
      reviewThreads: async (pull, selectedLines) => readReviewThreads(pr.token, pull.repo, pull.number, selectedLines),
      // Marked as from outside the app: the asker may not be the session's
      // owner, so it mustn't reach the session's Slack thread as theirs.
      wakeAndSend: (ownerId, workspaceId, prompt) => wakeAndSend(ownerId, workspaceId, prompt, "github"),
      startSession: startSoon(startServerSession, (rest) => after(() => rest)),
      link: linkSession,
      humanSpoke: resetCiTurns,
    },
  );
  if (outcome.kind === "refused") return NextResponse.json({ error: outcome.reason }, { status: 409 });
  return NextResponse.json({
    kind: outcome.kind,
    sessionId: outcome.sessionId,
    own: outcome.ownerId === caller.owner.id,
    threads: outcome.threads,
    since: pr.headSha,
    askedAt,
  });
}

/**
 * How a change asked for is going: the session's state (starting, working,
 * done; and its last reply, for the asker's own session) and the commits
 * pushed to the PR since it was asked. Only for a session that works on
 * this PR.
 */
export async function GET(request: Request) {
  const caller = await triageCaller(request);
  if (caller instanceof NextResponse) return caller;
  const params = new URL(request.url).searchParams;
  const repo = params.get("repo");
  const number = Number(params.get("number"));
  const sessionId = params.get("session");
  const since = params.get("since");
  if (!repo || !sessionId || !since || !/^[0-9a-f]{7,40}$/i.test(since)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  // Read lightly: the page asks every few seconds while the change is made.
  const head = await pullHead(caller.actor, repo, number);
  if (head.kind === "unavailable") return NextResponse.json({ error: "GitHub couldn't be reached. Try again." }, { status: 502 });
  if (head.kind === "unreadable") return NextResponse.json({ error: "Pull request not found." }, { status: 404 });
  const pr = head.pull;
  const sessions = await linkedSessions(
    { projectId: pr.projectId, target: "pull", number: pr.number, headRef: pr.headRef },
    caller.actor.orgId,
  );
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return NextResponse.json({ error: "That session doesn't work on this pull request." }, { status: 404 });

  const [{ data: activity }, commits] = await Promise.all([
    createSupabaseAdminClient().from("session_activity").select("turn, waiting, reply_preview, replied_at").eq("workspace_id", sessionId).maybeSingle(),
    commitsSince(pr.token, pr.repo, since, pr.headSha),
  ]);
  const own = session.ownerId === caller.owner.id;
  return NextResponse.json({
    status: session.status,
    working: activity?.turn === "working",
    waiting: activity?.waiting ?? null,
    // A session's words are its owner's: a teammate sees what it pushed.
    reply: own ? (activity?.reply_preview ?? null) : null,
    repliedAt: activity?.replied_at ?? null,
    headSha: pr.headSha,
    commits,
  });
}
