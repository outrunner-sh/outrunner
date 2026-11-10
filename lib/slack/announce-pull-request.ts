import type { SlackConversation } from "@/lib/db/slack-agent";

/** A pull request GitHub says was opened. */
export type OpenedPullRequest = {
  /** GitHub's own id of the repository: what projects match by. */
  repoId: number;
  repoFullName: string;
  headRef: string;
  number: number;
  url: string;
  title: string;
};

/** What announcing a pull request reads and writes (announce-pull-request.deps.ts). */
export type AnnounceDeps = {
  /** The sessions on `headRef` that work in the repository: as their own,
   *  or as another of a session of several's — the installation's own orgs'
   *  projects of it only. */
  sessionsOn: (repoId: number, headRef: string) => Promise<string[]>;
  /** The work items those sessions work on. */
  itemsOf: (sessionIds: string[]) => Promise<{ id: string; number: number }[]>;
  conversationForItem: (itemId: string) => Promise<SlackConversation | null>;
  /** Make `pr` the thread's to follow, from scratch, unless it already is:
   *  false when it was (a redelivered event, or two at once). */
  claim: (conversationId: string, pr: { repo: string; number: number; url: string }) => Promise<boolean>;
  /** Say `text` in the thread, if its workspace still has the app. */
  post: (conversation: SlackConversation, text: string) => Promise<void>;
};

/**
 * A pull request opened from the branch of a session that works on an item
 * the agent filed: posted in that item's thread, where the validator's
 * verdict will follow on the PR. Once a PR: GitHub delivers an event again
 * (a redelivery, a retry after a slow answer), and a thread told twice also
 * had its verdict and merge followed again from scratch, the session archived
 * again after someone restored it. A new PR on the thread (after one closed
 * unmerged) starts over.
 */
export async function announcePullRequestWith(pr: OpenedPullRequest, deps: AnnounceDeps): Promise<void> {
  const sessions = await deps.sessionsOn(pr.repoId, pr.headRef);
  if (sessions.length === 0) return;
  for (const item of await deps.itemsOf(sessions)) {
    const conversation = await deps.conversationForItem(item.id);
    if (!conversation) continue;
    if (!(await deps.claim(conversation.id, { repo: pr.repoFullName, number: pr.number, url: pr.url }))) continue;
    // Claimed first, so a post that fails (Slack's rate limit, a token
    // revoked) isn't tried again by GitHub's retry: told once at most rather
    // than twice. The thread still follows the PR, its verdict and merge
    // posted as they come. Said in the log, and the next item's thread told.
    await deps
      .post(
        conversation,
        `Pull request for OR-${item.number}: <${pr.url}|#${pr.number} ${pr.title.replace(/[<>|]/g, "")}>. If the repository has the validation automation on, I'll post its verdict here, and when it's merged.`,
      )
      .catch((error: unknown) =>
        console.error(`Slack agent: couldn't announce ${pr.repoFullName}#${pr.number} in ${conversation.id}`, error),
      );
  }
}
