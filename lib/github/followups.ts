/**
 * The GitHub agent loop's follow-ups: what happens on a pull request a
 * session works on, sent to that session without anyone mentioning it.
 *
 *   CI failing   check suites, check runs and workflow runs that end failed
 *                on its head commit: one turn per commit with the failing
 *                checks and their logs, asking it to fix and push. At most
 *                MAX_CI_TURNS in a row with no word from a person between
 *                (a mention, a review, or a message in Outrunner); then the
 *                pull request is told CI waits for one.
 *   reviews      a review submitted by a person who may steer it (changes
 *                requested, or comments): reviews in quick succession go as
 *                one turn.
 *
 * A burst of events is queued (github_followups) and sent once it has been
 * quiet for a while: by the webhook's own wait, and by the cron's tick for
 * any a restart cut off (flushFollowUps). The parts with no I/O are pure;
 * the rest takes its deps (followups.deps.ts).
 */

import type { CheckRun } from "@/lib/github/ci";
import type { ApiReview, ApiReviewComment } from "@/lib/github/conversation";
import type { LinkedSession, LinkTarget } from "@/lib/github/loop";
import { isBot, lineLabel, mentionsOutrunner, skipsOutrunner } from "@/lib/github/mentions";
import { type AccessLevel, allows } from "@/lib/orgs/access";

/** CI turns in a row, with no person's word between, before CI waits for one. */
export const MAX_CI_TURNS = 3;
/** How long a burst of CI events is quiet before it's sent. */
export const CI_SETTLE_SECONDS = 90;
/** How long a review batch waits for more reviews. */
export const REVIEW_SETTLE_SECONDS = 45;
/** How long a CI turn waits for checks still running on its commit, from
 *  its first failure, before it goes with what has failed. */
export const CI_WAIT_MAX_MS = 15 * 60_000;

/** How a check that failed ends: not cancelled or skipped, which a person
 *  (or a newer push) did. */
export const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out", "startup_failure"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** CI that failed on a commit, and the pull requests it's for. */
export type CiFailure = {
  installationId: number;
  repoFullName: string;
  headSha: string;
  headBranch: string | null;
  /** The repository's own pull requests GitHub names for it; none for a
   *  fork's, or when GitHub didn't say. */
  prNumbers: number[];
};

type PullRef = { number?: unknown; head?: { repo?: { id?: unknown } | null } | null; base?: { repo?: { id?: unknown } | null } | null };

type CiPayload = {
  action?: unknown;
  installation?: { id?: unknown } | null;
  repository?: { full_name?: unknown } | null;
  check_suite?: {
    conclusion?: unknown;
    head_sha?: unknown;
    head_branch?: unknown;
    pull_requests?: PullRef[] | null;
    app?: { slug?: unknown } | null;
  } | null;
  check_run?: {
    conclusion?: unknown;
    head_sha?: unknown;
    pull_requests?: PullRef[] | null;
    app?: { slug?: unknown } | null;
    check_suite?: { head_branch?: unknown } | null;
  } | null;
  workflow_run?: {
    conclusion?: unknown;
    head_sha?: unknown;
    head_branch?: unknown;
    pull_requests?: PullRef[] | null;
  } | null;
};

/**
 * A `check_suite`, `check_run` or `workflow_run` that completed failed, or
 * null. The App's own checks (an automation run's) never count: they inform,
 * and never fail.
 */
export function readCiFailure(event: string | null, payload: unknown, appSlug?: string): CiFailure | null {
  const p = (payload ?? {}) as CiPayload;
  if (p.action !== "completed") return null;
  let run: { conclusion?: unknown; head_sha?: unknown; pull_requests?: PullRef[] | null } | null | undefined;
  let headBranch: unknown = null;
  let app: unknown = null;
  if (event === "check_suite") {
    run = p.check_suite;
    headBranch = p.check_suite?.head_branch;
    app = p.check_suite?.app?.slug;
  } else if (event === "check_run") {
    run = p.check_run;
    headBranch = p.check_run?.check_suite?.head_branch;
    app = p.check_run?.app?.slug;
  } else if (event === "workflow_run") {
    run = p.workflow_run;
    headBranch = p.workflow_run?.head_branch;
  } else {
    return null;
  }
  const installationId = positive(p.installation?.id);
  const repoFullName = text(p.repository?.full_name);
  const headSha = text(run?.head_sha);
  const conclusion = text(run?.conclusion);
  if (!run || !installationId || !repoFullName || !headSha || !/^[0-9a-f]{40}$/.test(headSha)) return null;
  if (!conclusion || !FAILED_CONCLUSIONS.has(conclusion)) return null;
  if (appSlug && typeof app === "string" && app.toLowerCase() === appSlug.toLowerCase()) return null;
  const prNumbers = (run.pull_requests ?? []).flatMap((pr) => {
    const number = positive(pr?.number);
    const head = pr?.head?.repo?.id;
    const base = pr?.base?.repo?.id;
    // A fork's pull request, named on its own repository's run.
    return number && (head === undefined || base === undefined || head === base) ? [number] : [];
  });
  return { installationId, repoFullName, headSha, headBranch: text(headBranch), prNumbers: [...new Set(prNumbers)] };
}

/** A submitted review that may be for the session. */
export type ReviewSubmitted = {
  installationId: number;
  repoFullName: string;
  number: number;
  reviewId: number;
  headRef: string | null;
};

type ReviewPayload = {
  action?: unknown;
  installation?: { id?: unknown } | null;
  repository?: { full_name?: unknown } | null;
  review?: { id?: unknown; state?: unknown; body?: unknown; user?: { login?: unknown; type?: unknown } | null } | null;
  pull_request?: { number?: unknown; head?: { ref?: unknown } | null } | null;
};

/** A `pull_request_review` submitted by a person, or null: a bot's, an
 *  approval with nothing said, or one that says `[skip outrunner]`. Whether
 *  its reviewer may steer is asked when it's sent. */
export function readReviewSubmitted(event: string | null, payload: unknown): ReviewSubmitted | null {
  if (event !== "pull_request_review") return null;
  const p = (payload ?? {}) as ReviewPayload;
  if (p.action !== "submitted") return null;
  const installationId = positive(p.installation?.id);
  const repoFullName = text(p.repository?.full_name);
  const reviewId = positive(p.review?.id);
  const number = positive(p.pull_request?.number);
  const login = text(p.review?.user?.login);
  if (!installationId || !repoFullName || !reviewId || !number || !login) return null;
  if (isBot({ login, type: text(p.review?.user?.type) ?? "User" })) return null;
  const body = typeof p.review?.body === "string" ? p.review.body : "";
  if (skipsOutrunner(body)) return null;
  const state = text(p.review?.state)?.toLowerCase();
  if (state !== "changes_requested" && state !== "commented" && state !== "approved") return null;
  return { installationId, repoFullName, number, reviewId, headRef: text(p.pull_request?.head?.ref) };
}

/** At most this much of one check's log goes to the session, */
const EXCERPT_CHARS = 4_000;
/** this many of its lines, */
const EXCERPT_LINES = 60;
/** and this much of all of them together. */
const EXCERPTS_CHARS = 16_000;

/**
 * The failing part of a GitHub Actions log: its lines up to the last error
 * GitHub marked (`##[error]`), or its end, without timestamps and with ANSI
 * colours taken out.
 */
export function logExcerpt(log: string): string {
  const lines = log.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/).map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ""));
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("##[error]")) {
      end = i + 1;
      break;
    }
  }
  const kept = lines.slice(Math.max(0, end - EXCERPT_LINES), end).join("\n");
  return kept.length > EXCERPT_CHARS ? `…${kept.slice(-EXCERPT_CHARS)}` : kept;
}

/** A failing check, as the session is told of it. */
export type FailingCheck = { name: string; conclusion: string; url: string | null; excerpt: string | null };

/** The checks of a commit that failed, and whether any is still running. */
export function checkState(runs: readonly CheckRun[]): { failing: CheckRun[]; running: boolean } {
  return {
    failing: runs.filter((r) => r.status === "completed" && r.conclusion !== null && FAILED_CONCLUSIONS.has(r.conclusion)),
    running: runs.some((r) => r.status !== "completed"),
  };
}

/** What a check that isn't a workflow's job says of itself, for its excerpt. */
export function outputExcerpt(run: Pick<CheckRun, "output">): string | null {
  const said = [run.output.title, run.output.summary, run.output.text].filter((s): s is string => !!s?.trim()).join("\n\n");
  return said ? (said.length > EXCERPT_CHARS ? `${said.slice(0, EXCERPT_CHARS)}…` : said) : null;
}

/** What a session is told when CI fails on its pull request. */
export function ciPrompt(input: {
  repoFullName: string;
  number: number;
  headSha: string;
  headRef: string;
  failing: readonly FailingCheck[];
  turn: number;
}): string {
  const lines = [
    `CI failed on the pull request this session works on (${input.repoFullName}#${input.number}), at ${input.headSha.slice(0, 7)}:`,
    "",
    ...input.failing.map((c) => `- ${c.name} (${c.conclusion.replace(/_/g, " ")})${c.url ? `: ${c.url}` : ""}`),
  ];
  let budget = EXCERPTS_CHARS;
  const excerpts = input.failing.filter((c) => c.excerpt);
  if (excerpts.length) {
    lines.push("", "What they logged, cut to where they failed:");
    for (const c of excerpts) {
      const excerpt = (c.excerpt as string).slice(-budget);
      if (budget <= 0 || !excerpt) break;
      budget -= excerpt.length;
      lines.push("", `${c.name}:`, "```", excerpt, "```");
    }
  }
  lines.push(
    "",
    `Find what's failing and fix it. Run what you can here to check the fix, then commit and push to the pull request's branch (\`git push origin HEAD:${input.headRef}\`). If a failure isn't this change's doing (a flaky test, an outage, a missing secret), don't change code for it: say so in a comment on the pull request instead (\`gh pr comment ${input.number}\`), never writing "@outrunner" in it.`,
    `This is fix ${input.turn} of at most ${MAX_CI_TURNS} in a row; after that, CI failing waits for a person.`,
  );
  return lines.join("\n");
}

/** What the pull request is told when CI has failed past MAX_CI_TURNS. */
export function cappedText(headSha: string): string {
  return `CI is still failing at ${headSha.slice(0, 7)} after ${MAX_CI_TURNS} fixes in a row from the session, so I've left this one for a person. Comment \`@outrunner\` with what to do, or leave a review, and CI failures go back to the session.`;
}

/** A review as the session is told of it. */
export type ReviewForSession = {
  author: string;
  state: string;
  url: string | null;
  body: string;
  comments: { author: string; url: string | null; body: string; where: string; diffHunk: string | null }[];
};

/** Lines of a diff hunk that go with a review comment: those nearest it. */
const REVIEW_HUNK_LINES = 8;

/**
 * A review as the session gets it: only what a person said to it (comments
 * that mention Outrunner went to it on their own; `[skip outrunner]` and
 * bots' are left out), or null when that leaves nothing to say. An approval
 * with no comments says nothing to do.
 */
export function reviewForSession(review: ApiReview, comments: readonly ApiReviewComment[], appSlug?: string): ReviewForSession | null {
  const state = (review.state ?? "").toLowerCase();
  const body = review.body?.trim() ?? "";
  if (skipsOutrunner(body)) return null;
  const kept = comments.filter((c) => {
    const login = c.user?.login ?? "";
    const said = c.body ?? "";
    return said.trim() && !isBot({ login, type: c.user?.type ?? "User" }) && !skipsOutrunner(said) && !mentionsOutrunner(said, appSlug);
  });
  const asks = state === "changes_requested" || kept.length > 0 || (state === "commented" && body !== "");
  if (!asks) return null;
  return {
    author: review.user?.login ?? "someone",
    state,
    url: review.html_url ?? null,
    body: mentionsOutrunner(body, appSlug) ? "" : body,
    comments: kept.map((c) => ({
      author: c.user?.login ?? "someone",
      url: c.html_url ?? null,
      body: (c.body ?? "").trim(),
      where: lineLabel({
        path: c.path ?? "?",
        line: c.line ?? c.original_line ?? null,
        startLine: c.start_line ?? null,
        side: c.side ?? null,
        diffHunk: null,
      }),
      diffHunk: c.diff_hunk ? c.diff_hunk.split("\n").slice(-REVIEW_HUNK_LINES).join("\n") : null,
    })),
  };
}

function quote(body: string): string {
  return body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** What a session is told of the reviews of its pull request, as one turn. */
export function reviewPrompt(input: { repoFullName: string; number: number; headRef: string; reviews: readonly ReviewForSession[] }): string {
  const lines = [`New review${input.reviews.length > 1 ? "s" : ""} on the pull request this session works on (${input.repoFullName}#${input.number}):`];
  for (const r of input.reviews) {
    const verb = r.state === "changes_requested" ? "requested changes" : r.state === "approved" ? "approved, with comments" : "reviewed";
    lines.push("", `@${r.author} ${verb}${r.url ? ` (${r.url})` : ""}${r.body || r.comments.length ? ":" : "."}`);
    if (r.body) lines.push("", quote(r.body));
    for (const c of r.comments) {
      lines.push("", `On ${c.where}${c.url ? ` (${c.url})` : ""}:`);
      if (c.diffHunk) lines.push("```diff", c.diffHunk, "```");
      lines.push(quote(c.body));
    }
  }
  lines.push(
    "",
    `Address what they asked: change what should change, commit, and push to the pull request's branch (\`git push origin HEAD:${input.headRef}\`). Where you disagree or need more from them, reply on the pull request (\`gh pr comment ${input.number}\`) instead, never writing "@outrunner" in it.`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Queueing and sending.
// ---------------------------------------------------------------------------

/** A follow-up waiting to go. */
export type DueFollowUp = {
  id: string;
  kind: "ci" | "review";
  installationId: number;
  projectId: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  reviewIds: number[];
  firstAt: string;
};

/** A pull request as a follow-up needs it. */
export type PullState = { open: boolean; headSha: string; headRef: string };

export type FollowUpDeps = {
  scope(installationId: number, repoFullName: string, projectId?: string): Promise<{ orgId: string; projectId: string } | null>;
  claim(key: string): Promise<boolean>;
  linkedSessions(link: LinkTarget, orgId: string): Promise<LinkedSession[]>;
  /** The pull request a session recorded for a branch, when GitHub named
   *  none for a run. */
  pullForBranch(projectId: string, headBranch: string): Promise<number | null>;
  queue(followUp: {
    kind: "ci" | "review";
    installationId: number;
    projectId: string;
    repoFullName: string;
    prNumber: number;
    headSha?: string;
    reviewId?: number;
    delaySeconds: number;
  }): Promise<{ id: string; fresh: boolean } | null>;
  /** Give a claim back: what it was for wasn't queued. */
  release(key: string): Promise<void>;
  /** When each follow-up is due, and whether it has gone (taken or settled). */
  times(ids: readonly string[]): Promise<{ id: string; dueAt: string; done: boolean }[]>;
  /** Follow-ups due, oldest first. */
  due(limit: number): Promise<DueFollowUp[]>;
  postpone(id: string, seconds: number): Promise<void>;
  /** Take a due one to send (claim_github_followup): null when another has. */
  take(id: string): Promise<{ outcome: "send" | "capped" | "quiet"; turns: number } | null>;
  /** Say how it went; one not taken yet is taken by it. */
  settle(id: string, outcome: string): Promise<void>;
  pull(installationId: number, repoFullName: string, number: number): Promise<PullState | null>;
  checkRuns(installationId: number, repoFullName: string, sha: string): Promise<CheckRun[]>;
  jobLog(installationId: number, repoFullName: string, jobId: number): Promise<string | null>;
  review(
    installationId: number,
    repoFullName: string,
    number: number,
    reviewId: number,
  ): Promise<{ review: ApiReview; comments: ApiReviewComment[] } | null>;
  member(githubUserId: number, orgId: string): Promise<string | null>;
  /** A member's level on the project: read is heard by their own session;
   *  write, by anyone's. */
  level(userId: string, projectId: string): Promise<AccessLevel | null>;
  /** Send to a session as its owner, woken first; "github-ci" isn't a
   *  person's word, so CI's turns aren't counted again by it. */
  wakeAndSend(ownerId: string, workspaceId: string, prompt: string, from: "github" | "github-ci"): Promise<boolean>;
  /** A person spoke on the pull request: CI's turns count from none. */
  humanSpoke(projectId: string, prNumber: number): Promise<void>;
  comment(installationId: number, repoFullName: string, number: number, body: string): Promise<void>;
  /** The App's slug as GitHub has it: comments mentioning it went to the
   *  session as mentions already. */
  appSlug(): Promise<string | undefined>;
  now(): number;
  sleep(ms: number): Promise<void>;
};

/**
 * Queue CI that failed for each linked pull request it's for, to go once the
 * burst is over. The follow-ups this event made (new, or opened again after
 * a re-run passed): only it waits for them to go (waitAndFlush); the
 * burst's other events only put them later. One already sent for the commit
 * stays sent (one turn per commit).
 */
export async function queueCiFailure(event: string | null, payload: unknown, deps: FollowUpDeps, appSlug?: string): Promise<string[]> {
  const failure = readCiFailure(event, payload, appSlug);
  if (!failure) return [];
  const scope = await deps.scope(failure.installationId, failure.repoFullName);
  if (!scope) return [];
  let numbers = failure.prNumbers;
  if (numbers.length === 0 && failure.headBranch) {
    const found = await deps.pullForBranch(scope.projectId, failure.headBranch);
    numbers = found ? [found] : [];
  }
  const fresh: string[] = [];
  for (const number of numbers) {
    const sessions = await deps.linkedSessions(
      { projectId: scope.projectId, target: "pull", number, headRef: failure.headBranch },
      scope.orgId,
    );
    if (sessions.length === 0) continue;
    const queued = await deps.queue({
      kind: "ci",
      installationId: failure.installationId,
      projectId: scope.projectId,
      repoFullName: failure.repoFullName,
      prNumber: number,
      headSha: failure.headSha,
      delaySeconds: CI_SETTLE_SECONDS,
    });
    if (queued?.fresh) fresh.push(queued.id);
  }
  return fresh;
}

/** Queue a submitted review into its linked pull request's batch; once per
 *  review, whatever GitHub redelivers. The batch, if this review began it
 *  (only then does this event wait for it to go). */
export async function queueReview(event: string | null, payload: unknown, deps: FollowUpDeps): Promise<string | null> {
  const review = readReviewSubmitted(event, payload);
  if (!review) return null;
  const scope = await deps.scope(review.installationId, review.repoFullName);
  if (!scope) return null;
  const sessions = await deps.linkedSessions(
    { projectId: scope.projectId, target: "pull", number: review.number, headRef: review.headRef },
    scope.orgId,
  );
  if (sessions.length === 0) return null;
  const key = `review:${review.reviewId}:${scope.projectId}`;
  if (!(await deps.claim(key))) return null;
  let queued: Awaited<ReturnType<FollowUpDeps["queue"]>>;
  try {
    queued = await deps.queue({
      kind: "review",
      installationId: review.installationId,
      projectId: scope.projectId,
      repoFullName: review.repoFullName,
      prNumber: review.number,
      reviewId: review.reviewId,
      delaySeconds: REVIEW_SETTLE_SECONDS,
    });
  } catch (error) {
    // Not queued: GitHub's redelivery may try again. (Into a batch that's
    // open, a review twice is once: its ids are a set.)
    await deps.release(key).catch(() => undefined);
    throw error;
  }
  return queued?.fresh ? queued.id : null;
}

/** How long the event that made a follow-up waits for it to go before the
 *  cron's tick has it: past CI's wait for checks still running. */
export const WAIT_MAX_MS = CI_WAIT_MAX_MS + 5 * 60_000;

/**
 * Wait for follow-ups this event made, sending what's due as each comes
 * due: a burst's later events, and checks still running, put them later,
 * so it waits again until they've gone. Past WAIT_MAX_MS, when they can't
 * be read, or when one fails to send, the cron's tick has them.
 */
export async function waitAndFlush(ids: readonly string[], deps: FollowUpDeps): Promise<void> {
  const until = deps.now() + WAIT_MAX_MS;
  while (ids.length && deps.now() < until) {
    const waiting = (await deps.times(ids)).filter((t) => !t.done);
    if (waiting.length === 0) return;
    const next = Math.min(...waiting.map((t) => Date.parse(t.dueAt)));
    await deps.sleep(Math.max(5_000, next - deps.now() + 2_000));
    const results = await flushFollowUps(deps);
    // One of ours failed (GitHub down, say): the cron's tick tries it again
    // every two minutes, rather than this every few seconds.
    if (ids.some((id) => results.get(id) === "error")) return;
  }
}

/** At most this many failing checks get their logs read. */
const LOGS_MAX = 5;
/** A follow-up that couldn't go for this long (GitHub refusing to read the
 *  pull request, say) is let go rather than tried each tick for ever. */
export const FOLLOW_UP_EXPIRES_MS = 24 * 60 * 60_000;

/** Send what's due, each once. How each went, by id. Never throws: one that
 *  fails is left due, for the next tick, if it wasn't taken. */
export async function flushFollowUps(deps: FollowUpDeps, limit = 20): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  for (const followUp of await deps.due(limit)) {
    try {
      if (deps.now() - Date.parse(followUp.firstAt) > FOLLOW_UP_EXPIRES_MS) {
        await deps.settle(followUp.id, "expired");
        results.set(followUp.id, "expired");
        continue;
      }
      results.set(followUp.id, followUp.kind === "ci" ? await sendCi(followUp, deps) : await sendReviews(followUp, deps));
    } catch (error) {
      console.error(`GitHub follow-up ${followUp.id} failed`, error);
      results.set(followUp.id, "error");
    }
  }
  return results;
}

async function sendTo(sessions: readonly LinkedSession[], prompt: string, from: "github" | "github-ci", deps: FollowUpDeps): Promise<boolean> {
  for (const session of sessions.slice(0, 3)) {
    if (await deps.wakeAndSend(session.ownerId, session.id, prompt, from).catch(() => false)) return true;
  }
  return false;
}

async function sendCi(f: DueFollowUp, deps: FollowUpDeps): Promise<string> {
  const settle = async (outcome: string) => {
    await deps.settle(f.id, outcome);
    return outcome;
  };
  const scope = await deps.scope(f.installationId, f.repoFullName, f.projectId);
  if (!scope) return settle("no_scope");
  const pull = await deps.pull(f.installationId, f.repoFullName, f.prNumber);
  if (!pull) throw new Error(`couldn't read ${f.repoFullName}#${f.prNumber}`);
  if (!pull.open) return settle("closed");
  // Pushed since: the new commit's CI is its own.
  if (pull.headSha !== f.headSha) return settle("stale");
  const sessions = await deps.linkedSessions({ projectId: f.projectId, target: "pull", number: f.prNumber, headRef: pull.headRef }, scope.orgId);
  if (sessions.length === 0) return settle("no_session");

  const { failing, running } = checkState(await deps.checkRuns(f.installationId, f.repoFullName, f.headSha));
  if (running && deps.now() - Date.parse(f.firstAt) < CI_WAIT_MAX_MS) {
    await deps.postpone(f.id, 60);
    return "waiting";
  }
  // Run again and passed meanwhile.
  if (failing.length === 0) return settle("passed");

  const taken = await deps.take(f.id);
  if (!taken) return "taken";
  if (taken.outcome === "quiet") return settle("quiet");
  if (taken.outcome === "capped") {
    await deps.comment(f.installationId, f.repoFullName, f.prNumber, cappedText(f.headSha)).catch((error: unknown) =>
      console.error(`GitHub: couldn't say CI waits on ${f.repoFullName}#${f.prNumber}`, error),
    );
    return settle("capped");
  }
  const checks: FailingCheck[] = await Promise.all(
    failing.map(async (run, i) => ({
      name: run.name,
      conclusion: run.conclusion ?? "failure",
      url: run.url,
      excerpt:
        i >= LOGS_MAX
          ? null
          : run.app === "github-actions"
            ? await deps
                .jobLog(f.installationId, f.repoFullName, run.id)
                .then((log) => (log ? logExcerpt(log) : outputExcerpt(run)))
                .catch(() => outputExcerpt(run))
            : outputExcerpt(run),
    })),
  );
  const prompt = ciPrompt({
    repoFullName: f.repoFullName,
    number: f.prNumber,
    headSha: f.headSha,
    headRef: pull.headRef,
    failing: checks,
    turn: taken.turns,
  });
  return settle((await sendTo(sessions, prompt, "github-ci", deps)) ? "sent" : "unsent");
}

async function sendReviews(f: DueFollowUp, deps: FollowUpDeps): Promise<string> {
  const settle = async (outcome: string) => {
    await deps.settle(f.id, outcome);
    return outcome;
  };
  const scope = await deps.scope(f.installationId, f.repoFullName, f.projectId);
  if (!scope) return settle("no_scope");
  const pull = await deps.pull(f.installationId, f.repoFullName, f.prNumber);
  if (!pull) throw new Error(`couldn't read ${f.repoFullName}#${f.prNumber}`);
  if (!pull.open) return settle("closed");
  const sessions = await deps.linkedSessions({ projectId: f.projectId, target: "pull", number: f.prNumber, headRef: pull.headRef }, scope.orgId);
  if (sessions.length === 0) return settle("no_session");

  // Only a reviewer who may steer the session is heard: a member, by their
  // GitHub identity, who may read the repository; and, as the session runs
  // as its owner, its owner or a member who may write to it.
  const reviews: { userId: string; write: boolean; review: ReviewForSession }[] = [];
  for (const id of f.reviewIds) {
    // Deleted since: the rest of the batch goes without it.
    const read = await deps.review(f.installationId, f.repoFullName, f.prNumber, id);
    if (!read) continue;
    const { review, comments } = read;
    const githubId = review.user?.id;
    if (typeof githubId !== "number") continue;
    const userId = await deps.member(githubId, scope.orgId);
    if (!userId) continue;
    const level = await deps.level(userId, f.projectId);
    if (!allows(level, "read")) continue;
    // Their other comments in it are theirs too; anyone else's aren't
    // theirs to send.
    const own = comments.filter((c) => c.user?.id === githubId);
    const kept = reviewForSession(review, own, await deps.appSlug());
    if (kept) reviews.push({ userId, write: allows(level, "write"), review: kept });
  }
  const heardBy = (session: LinkedSession) => reviews.filter((r) => r.write || r.userId === session.ownerId).map((r) => r.review);
  const targets = sessions.slice(0, 3).filter((s) => heardBy(s).length > 0);
  if (targets.length === 0) return settle("nothing");

  const taken = await deps.take(f.id);
  if (!taken) return "taken";
  let sent = false;
  for (const session of targets) {
    const prompt = reviewPrompt({ repoFullName: f.repoFullName, number: f.prNumber, headRef: pull.headRef, reviews: heardBy(session) });
    if (await deps.wakeAndSend(session.ownerId, session.id, prompt, "github").catch(() => false)) {
      sent = true;
      break;
    }
  }
  if (sent) await deps.humanSpoke(f.projectId, f.prNumber).catch(() => undefined);
  return settle(sent ? "sent" : "unsent");
}
