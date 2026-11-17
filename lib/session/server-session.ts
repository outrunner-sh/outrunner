/**
 * A cloud session the server starts on a user's behalf (an automation's run),
 * with no browser of theirs: signed in as them (actAsUser), it's made and set
 * up exactly as one they start from the new-session screen, on their sandbox
 * and plan, and appears in their sessions.
 *
 * It runs on Outrunner's models, on the user's allowance of them (their
 * usage, in Settings → Usage), never on their own Claude or provider keys:
 * what the server starts on its own isn't billed to an account of theirs.
 * Unless it's asked to (`onHarness`: an org that set its automations to),
 * when it runs on what the user's new session would: their default model and
 * coding agent, on their own sign-in or key; or names a model of its own
 * (`choice`: an automation's), which runs on whoever serves it.
 */

import { getOwner } from "@/lib/auth/owner";
import { getWorkspace } from "@/lib/db/repositories";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { resolveProvider } from "@/lib/runtime/resolve";
import { archiveCloudSession } from "@/lib/session/archive-session";
import type { WorkspaceSource } from "@/lib/runtime/types";
import { createCloudSession, type SessionOutcome, type SessionRequest } from "@/lib/session/create-cloud-session";
import { startOnChoice } from "@/lib/session/server-session-choice";
import { ActAsUserError, actAsUser } from "@/lib/supabase/acting-user";

export type ServerSessionStart = {
  /** Who it runs as: a user id the server trusts, never one a request names. */
  userId: string;
  /** The repository (a `projects` row) it works in. */
  projectId: string;
  /** The branch it starts from; the repository's default when not given. */
  baseBranch?: string;
  /** Its own branch's name; a generated one when not given. */
  branch?: string;
  title: string;
  /** The prompt it runs, sent once it's ready. */
  prompt: string;
  /** Which of Outrunner's models it runs (OUTRUNNER_MODELS); their first
   *  when not given. */
  model?: string;
  /** A model of its own (an automation's): tried first, on whoever serves
   *  it, as a session asked for it from the new-session screen. One that
   *  can't start (not on the user's menu) starts as it would have without
   *  it, and its result's `fellBack` says why. */
  choice?: { provider: string; id: string; effort?: string | null };
  /** On the user's default model and coding agent (Claude Code or Codex, on
   *  their own sign-in or key) instead of Outrunner's models. One that can't
   *  start on it (signed out, say) starts on Outrunner's instead, and its
   *  result's `fellBack` says why. */
  onHarness?: boolean;
  /** It works on GitHub as the Outrunner App, reading code and commenting
   *  (an automation's review), whatever its user chose for their own. */
  reviewAsApp?: boolean;
  /** Told the session's id once its row is made, before its setup. */
  onCreated?: (workspaceId: string) => Promise<void>;
  /** Where it was started: an automation's run, a Slack thread, an @mention on
   *  GitHub, or a delegation in Linear. */
  source: Extract<WorkspaceSource, "automation" | "slack" | "github" | "linear" | "jira">;
};

/** Made and set up: ready (its prompt sent) or failed, with why. Or not made
 *  at all (`workspaceId` null): the reason the new-session screen would show.
 *  `fellBack`: asked to run on a model of its own, or the user's own
 *  harness, it couldn't start on it and runs on what's next; why, to tell
 *  them. */
export type ServerSessionResult =
  | (SessionOutcome & { fellBack?: string })
  | { workspaceId: null; status: "refused"; errorMessage: string };


/**
 * Start a session as `userId` and wait for its setup, which is long (a box to
 * start, a repository to fetch): call it from after() or a background job,
 * never in a request a person waits on.
 */
export async function startServerSession(start: ServerSessionStart): Promise<ServerSessionResult> {
  return startOnChoice(start, (request) => startAs(start, request));
}

async function startAs(start: ServerSessionStart, request: SessionRequest): Promise<ServerSessionResult> {
  // Once its row is made, how it went is that session's: never "refused".
  let made: string | null = null;
  try {
    return await actAsUser(start.userId, async () => {
      const owner = await getOwner();
      if (!owner) return refused("That user can't use Outrunner any more.");
      let outcome: SessionOutcome | null = null;
      const response = await createCloudSession(
        owner,
        start.projectId,
        request,
        {
          baseBranch: start.baseBranch,
          title: start.title,
          firstMessage: start.prompt,
          inline: true,
          meteredOnly: true,
          reviewAsApp: start.reviewAsApp,
          onCreated: start.onCreated,
          source: start.source,
          onSettled: async (settled) => {
            outcome = settled;
          },
        },
      );
      const body = (await response.json().catch(() => null)) as { error?: unknown; workspace?: { id?: unknown } } | null;
      if (response.status !== 202) {
        return refused(typeof body?.error === "string" ? body.error : `The session couldn't start (${response.status}).`);
      }
      made = typeof body?.workspace?.id === "string" ? body.workspace.id : null;
      return outcome ?? failed(made, "The session's setup ended without saying how.");
    });
  } catch (error) {
    if (error instanceof ActAsUserError) return refused(error.message);
    console.error(`Could not start a session for ${start.userId}`, error);
    return failed(made, "The session couldn't start. Outrunner logged why.");
  }
}

/** Failed: the session's, once there is one, else not made at all. */
function failed(workspaceId: string | null, errorMessage: string): ServerSessionResult {
  return workspaceId ? { workspaceId, status: "failed", errorMessage } : refused(errorMessage);
}

function refused(errorMessage: string): ServerSessionResult {
  return { workspaceId: null, status: "refused", errorMessage };
}

/**
 * Archive sessions of `userId`'s, as they would from the session page: an
 * automation's earlier review sessions, once a new one has taken over. One
 * not ready or idle (stopped, deleted, already archived) is left as it is.
 * How many were archived; never throws.
 */
export async function archiveServerSessions(
  userId: string,
  workspaceIds: readonly string[],
  /** Delete each one's own box once its Snapshot is saved, rather than pause
   *  it (lib/session/archive-session.ts): only for sessions nobody comes back
   *  to, an automation's review sessions once superseded or their pull
   *  request closed. The Slack, GitHub-loop and run-route archives keep the
   *  box paused, as Restore there is expected. */
  options: { dropBox?: boolean } = {},
): Promise<number> {
  if (workspaceIds.length === 0) return 0;
  try {
    return await actAsUser(userId, async () => {
      const owner = await getOwner();
      if (!owner) return 0;
      let archived = 0;
      for (const id of workspaceIds) {
        // One that fails doesn't keep the rest from being archived.
        try {
          const workspace = await getWorkspace(id);
          if (!workspace || workspace.ownerId !== owner.id) continue;
          if (workspace.status !== "ready" && workspace.status !== "idle") continue;
          const resolution = resolveProvider(workspace);
          if (!resolution.ok || !isComputerProvider(resolution.provider)) continue;
          const result = await archiveCloudSession(workspace, resolution.provider, owner, { dropBox: options.dropBox });
          if (result.ok) archived++;
          else console.warn(`Couldn't archive the session ${id}`, result);
        } catch (error) {
          console.error(`Couldn't archive the session ${id}`, error);
        }
      }
      return archived;
    });
  } catch (error) {
    console.error(`Couldn't archive earlier sessions for ${userId}`, error);
    return 0;
  }
}
