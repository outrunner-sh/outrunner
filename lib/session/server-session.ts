/**
 * A cloud session the server starts on a user's behalf (an automation's run),
 * with no browser of theirs: signed in as them (actAsUser), it's made and set
 * up exactly as one they start from the new-session screen, on their sandbox
 * and plan, and appears in their sessions.
 *
 * It always runs on Outrunner's models, on the user's allowance of them (their
 * usage, in Settings → Usage), never on their own Claude or provider keys:
 * what the server starts on its own isn't billed to an account of theirs.
 */

import { getOwner } from "@/lib/auth/owner";
import { OUTRUNNER_MODELS } from "@/lib/runtime/session-models";
import { createCloudSession, type SessionOutcome } from "@/lib/session/create-cloud-session";
import { ActAsUserError, actAsUser } from "@/lib/supabase/acting-user";

export type ServerSessionStart = {
  /** Who it runs as: a user id the server trusts, never one a request names. */
  userId: string;
  /** The repository (a `projects` row) it works in. */
  projectId: string;
  /** The branch it starts from; the repository's default when not given. */
  baseBranch?: string;
  title: string;
  /** The prompt it runs, sent once it's ready. */
  prompt: string;
  /** Which of Outrunner's models it runs (OUTRUNNER_MODELS); their first
   *  when not given. */
  model?: string;
  /** Its own GitHub token, in place of the user's: the Outrunner GitHub
   *  App's, so what it posts is the app's. */
  githubToken?: string;
};

/** Made and set up: ready (its prompt sent) or failed, with why. Or not made
 *  at all (`workspaceId` null): the reason the new-session screen would show. */
export type ServerSessionResult =
  | SessionOutcome
  | { workspaceId: null; status: "refused"; errorMessage: string };

/**
 * Start a session as `userId` and wait for its setup, which is long (a box to
 * start, a repository to fetch): call it from after() or a background job,
 * never in a request a person waits on.
 */
export async function startServerSession(start: ServerSessionStart): Promise<ServerSessionResult> {
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
        // Outrunner's models, on Outrunner's key (not `key: "own"`): the
        // user's allowance, not their Claude or their own OpenRouter key.
        { provider: "outrunner", model: start.model ?? OUTRUNNER_MODELS[0].id, prompt: start.prompt },
        {
          baseBranch: start.baseBranch,
          title: start.title,
          firstMessage: start.prompt,
          sessionGithubToken: start.githubToken,
          inline: true,
          meteredOnly: true,
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
