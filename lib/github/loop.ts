/**
 * The GitHub agent loop (Replicas' way), as the Outrunner GitHub App's webhook
 * runs it after answering GitHub:
 *
 *   mention  `@outrunner` on an issue, a pull request or a line of one: the
 *            session working on it hears the comment (woken first if it
 *            sleeps), or a new one starts on it, as the commenter. The
 *            comment gets 👀, and a reply linking the session.
 *   close    an issue or pull request closed (or merged): the sessions
 *            working on it are archived, while the org's default says so.
 *
 * Only members of the org holding the installation steer a session, and only
 * on repositories Roles & access lets them read: a GitHub account counts as
 * the member whose GitHub identity it is. A session runs as its owner, so
 * another member's word reaches it only if they may write to the repository. Each act is claimed by what it's
 * for before anything is done (a comment's id, a close's time), so a
 * redelivery does nothing twice. The I/O is passed in (loop.deps.ts).
 */

import {
  associated,
  followUpPrompt,
  type Mention,
  mentionKey,
  type MentionReply,
  mentionTitle,
  type PullBranches,
  readMention,
  replyText,
  startPrompt,
} from "@/lib/github/mentions";
import { type AccessLevel, allows } from "@/lib/orgs/access";
import type { ServerSessionResult, ServerSessionStart } from "@/lib/session/server-session";

/** A session working on an issue or a pull request. */
export type LinkedSession = { id: string; ownerId: string; status: string };

/** What a session is linked to: an issue, or a pull request (also found by
 *  its head branch, the branch a session that opened it works on). */
export type LinkTarget = { projectId: string; target: "issue" | "pull"; number: number; headRef?: string | null };

export type LoopDeps = {
  /** The org holding the installation (claimed, not suspended), and its
   *  project that is the repository; null when there's none. */
  scope(installationId: number, repoFullName: string): Promise<{ orgId: string; projectId: string } | null>;
  /** Claim an act by its key: false when it was claimed already. */
  claim(key: string): Promise<boolean>;
  /** Give a claim back, so a redelivery tries again. */
  release(key: string): Promise<void>;
  /** The org member whose GitHub identity the account is, if they may still
   *  use Outrunner. */
  member(githubUserId: number, orgId: string): Promise<string | null>;
  /** A member's level on the project: read starts sessions on it; write
   *  also steers a session of someone else's. */
  level(userId: string, projectId: string): Promise<AccessLevel | null>;
  /** The sessions working on it, newest first, whose owners are still in
   *  the org: never an automation's review sessions. One found only by its
   *  branch is used only when none is linked to it outright, and is linked
   *  from then on. */
  linkedSessions(link: LinkTarget, orgId: string): Promise<LinkedSession[]>;
  /** A pull request's branches, read from GitHub. */
  pullBranches(installationId: number, repoFullName: string, number: number): Promise<PullBranches | null>;
  /** Send a prompt to a session as its owner, waking or restoring it first;
   *  false when it can't take one. */
  wakeAndSend(ownerId: string, workspaceId: string, prompt: string): Promise<boolean>;
  startServerSession(start: ServerSessionStart): Promise<ServerSessionResult>;
  /** Record that a session works on an issue or pull request. */
  link(link: LinkTarget & { url: string; title: string; baseRef?: string }, workspace: { id: string; ownerId: string }): Promise<void>;
  react(installationId: number, repoFullName: string, comment: Mention["comment"]): Promise<void>;
  reply(installationId: number, repoFullName: string, mention: Mention, body: string): Promise<void>;
  sessionUrl(workspaceId: string): string;
  /** Whether the org archives sessions when their issue or pull request
   *  closes (its default: yes). */
  archiveOnClose(orgId: string): Promise<boolean>;
  /** Resume a paused session as its owner: archiving takes its snapshot on
   *  its box. Whether it's up. */
  wake(ownerId: string, workspaceId: string): Promise<boolean>;
  /** Put a session woken for archiving back to sleep, as its owner. */
  suspend(ownerId: string, workspaceId: string): Promise<boolean>;
  archiveServerSessions(userId: string, workspaceIds: readonly string[]): Promise<number>;
  /** A person spoke on a pull request: its CI follow-ups count their turns
   *  from none (lib/github/followups.ts). */
  humanSpoke(projectId: string, prNumber: number): Promise<void>;
};

/** What became of a mention, for the logs and the tests. */
export type MentionOutcome =
  | "ignored"
  | "repeat"
  | "not_member"
  | "no_access"
  | "sent"
  | "started"
  | "failed"
  | "fork";

/**
 * Act on a comment, if it's a mention of Outrunner by someone who may steer
 * the issue's or pull request's session. Throws only before anything was
 * done (its claim given back, for GitHub's redelivery to try again).
 */
export async function handleMention(event: string | null, payload: unknown, deps: LoopDeps, appSlug?: string): Promise<MentionOutcome> {
  const mention = readMention(event, payload, appSlug);
  if (typeof mention === "string") return "ignored";
  const scope = await deps.scope(mention.installationId, mention.repoFullName);
  if (!scope) return "ignored";
  const key = mentionKey(mention);
  if (!(await deps.claim(key))) return "repeat";

  // Said on GitHub: a reply that fails is logged, not retried, as what it
  // answers was done.
  const say = (reply: MentionReply) =>
    deps
      .reply(mention.installationId, mention.repoFullName, mention, replyText(reply))
      .catch((error: unknown) => console.error(`GitHub: couldn't reply to ${key}`, error));

  let acted = false;
  try {
    const userId = await deps.member(mention.author.id, scope.orgId);
    if (!userId) {
      acted = true;
      if (associated(mention.authorAssociation)) await say({ kind: "not_member" });
      return "not_member";
    }
    const level = await deps.level(userId, scope.projectId);
    if (!allows(level, "read")) {
      acted = true;
      if (associated(mention.authorAssociation)) await say({ kind: "no_access", repoFullName: mention.repoFullName });
      return "no_access";
    }
    await deps
      .react(mention.installationId, mention.repoFullName, mention.comment)
      .catch((error: unknown) => console.error(`GitHub: couldn't react to ${key}`, error));

    const pull =
      mention.target === "pull"
        ? (mention.pull ?? (await deps.pullBranches(mention.installationId, mention.repoFullName, mention.number)))
        : null;
    const link: LinkTarget = { projectId: scope.projectId, target: mention.target, number: mention.number, headRef: pull?.headRef ?? null };

    // The session already on it, woken if it sleeps: the newest that takes
    // the comment. It runs as its owner, with their GitHub access: only they,
    // or a member who may write to the repository, steer it. Anyone else
    // gets a session of their own.
    const prompt = followUpPrompt(mention, appSlug);
    const steerable = (await deps.linkedSessions(link, scope.orgId)).filter(
      (s) => s.ownerId === userId || allows(level, "write"),
    );
    const spoke = () =>
      mention.target === "pull"
        ? deps.humanSpoke(scope.projectId, mention.number).catch((error: unknown) => console.error(`GitHub: couldn't reset CI's turns for ${key}`, error))
        : Promise.resolve();
    for (const session of steerable.slice(0, 3)) {
      if (await deps.wakeAndSend(session.ownerId, session.id, prompt).catch(() => false)) {
        acted = true;
        await spoke();
        await say({ kind: "sent", url: deps.sessionUrl(session.id) });
        return "sent";
      }
    }

    if (mention.target === "pull" && !pull) {
      acted = true;
      await say({ kind: "failed", reason: "GitHub didn't let me read the pull request" });
      return "failed";
    }
    if (pull?.fromFork) {
      acted = true;
      await say({ kind: "fork" });
      return "fork";
    }

    // A new one, as the commenter: on the pull request's head, or the
    // repository's default branch for an issue. It's linked, and the link
    // replied, as soon as it's made; its setup takes minutes.
    acted = true;
    await spoke();
    const mentionWithPull: Mention = { ...mention, pull };
    const result = await deps.startServerSession({
      userId,
      projectId: scope.projectId,
      baseBranch: pull?.headRef,
      title: mentionTitle(mention),
      prompt: startPrompt(mentionWithPull, appSlug),
      source: "github",
      onCreated: async (workspaceId) => {
        await deps.link(
          { ...link, url: mention.url, title: mention.title, baseRef: pull?.baseRef },
          { id: workspaceId, ownerId: userId },
        );
        // Not awaited: the session's setup waits on this, and GitHub can be
        // slow to answer. `say` logs its own failure.
        void say({ kind: "started", url: deps.sessionUrl(workspaceId) });
      },
    });
    if (result.status === "ready") return "started";
    await say({ kind: "failed", reason: result.errorMessage ?? "its setup failed" });
    return "failed";
  } catch (error) {
    if (!acted) await deps.release(key).catch(() => undefined);
    throw error;
  }
}

/** An issue or pull request closed (a merge is a close). */
export type Closed = {
  installationId: number;
  repoFullName: string;
  target: "issue" | "pull";
  number: number;
  headRef: string | null;
  /** When: a close after a reopen is another close. */
  closedAt: string;
};

type ClosePayload = {
  action?: unknown;
  installation?: { id?: unknown } | null;
  repository?: { full_name?: unknown } | null;
  issue?: { number?: unknown; closed_at?: unknown; pull_request?: unknown } | null;
  pull_request?: { number?: unknown; closed_at?: unknown; head?: { ref?: unknown } | null } | null;
};

/** The issue or pull request an `issues` or `pull_request` event closed;
 *  null for any other. */
export function readClosed(event: string | null, payload: unknown): Closed | null {
  const p = (payload ?? {}) as ClosePayload;
  if (p.action !== "closed") return null;
  const installationId = typeof p.installation?.id === "number" ? p.installation.id : null;
  const repoFullName = typeof p.repository?.full_name === "string" ? p.repository.full_name : null;
  if (!installationId || !repoFullName) return null;
  const subject = event === "issues" ? p.issue : event === "pull_request" ? p.pull_request : null;
  const number = subject?.number;
  if (!subject || typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) return null;
  const headRef = event === "pull_request" ? p.pull_request?.head?.ref : null;
  return {
    installationId,
    repoFullName,
    target: event === "pull_request" ? "pull" : "issue",
    number,
    headRef: typeof headRef === "string" && headRef ? headRef : null,
    closedAt: typeof subject.closed_at === "string" ? subject.closed_at : "",
  };
}

/**
 * An issue or pull request closed: the sessions working on it are archived
 * (a snapshot each, restorable), each as its owner, while the org's default
 * is on; one asleep is woken to be. How many were. An automation's review
 * sessions are its own to archive (lib/automations/runs.ts, closeRuns).
 */
export async function archiveClosed(event: string | null, payload: unknown, deps: LoopDeps): Promise<number> {
  const closed = readClosed(event, payload);
  if (!closed) return 0;
  const scope = await deps.scope(closed.installationId, closed.repoFullName);
  if (!scope || !(await deps.archiveOnClose(scope.orgId))) return 0;
  const key = `close:${closed.target}:${scope.projectId}:${closed.number}:${closed.closedAt}`;
  if (!(await deps.claim(key))) return 0;
  try {
    const sessions = await deps.linkedSessions(
      { projectId: scope.projectId, target: closed.target, number: closed.number, headRef: closed.headRef },
      scope.orgId,
    );
    const what = `${closed.repoFullName}#${closed.number}`;
    const archiveOne = async (s: LinkedSession): Promise<number> => {
      if (s.status === "archived") return 0;
      if (s.status !== "ready" && s.status !== "idle" && s.status !== "suspended") {
        // Mid another step (suspending, resuming, restoring): left as it is.
        console.warn(`GitHub: session ${s.id} was ${s.status} as ${what} closed, so it wasn't archived`);
        return 0;
      }
      // Its snapshot is taken on its box: a session that went to sleep (as
      // most have by the time their pull request merges) is woken for it.
      const woken = s.status === "suspended";
      if (woken && !(await deps.wake(s.ownerId, s.id).catch(() => false))) {
        console.warn(`GitHub: session ${s.id} couldn't be woken to archive it as ${what} closed`);
        return 0;
      }
      const done = await deps.archiveServerSessions(s.ownerId, [s.id]);
      if (done === 0 && woken) {
        // Woken for nothing: back to sleep, rather than up until it idles.
        console.warn(`GitHub: session ${s.id} was woken but not archived as ${what} closed; putting it back to sleep`);
        await deps.suspend(s.ownerId, s.id).catch((error: unknown) => console.error(`GitHub: couldn't suspend ${s.id} again`, error));
      }
      return done;
    };
    // Owners side by side, as waking one is a box's start; each owner's one
    // at a time, as their wakes count against one plan's boxes.
    const byOwner = new Map<string, LinkedSession[]>();
    for (const s of sessions) byOwner.set(s.ownerId, [...(byOwner.get(s.ownerId) ?? []), s]);
    const archived = await Promise.all(
      [...byOwner.values()].map(async (own) => {
        let done = 0;
        for (const s of own) done += await archiveOne(s);
        return done;
      }),
    );
    return archived.reduce((sum, n) => sum + n, 0);
  } catch (error) {
    await deps.release(key).catch(() => undefined);
    throw error;
  }
}
