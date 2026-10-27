/**
 * A cloud session the server starts on a user's behalf (an automation's run),
 * with no browser of theirs: signed in as them (actAsUser), it's made and set
 * up exactly as one they start from the new-session screen, on their Claude,
 * sandbox and plan, and appears in their sessions.
 */

import { getOwner } from "@/lib/auth/owner";
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
  try {
    return await actAsUser(start.userId, async () => {
      const owner = await getOwner();
      if (!owner) return refused("That user can't use Outrunner any more.");
      let outcome: SessionOutcome | null = null;
      const response = await createCloudSession(
        owner,
        start.projectId,
        { prompt: start.prompt },
        {
          baseBranch: start.baseBranch,
          title: start.title,
          firstMessage: start.prompt,
          inline: true,
          onSettled: async (settled) => {
            outcome = settled;
          },
        },
      );
      if (response.status !== 202) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        return refused(typeof body?.error === "string" ? body.error : `The session couldn't start (${response.status}).`);
      }
      return outcome ?? refused("The session's setup ended without saying how.");
    });
  } catch (error) {
    if (error instanceof ActAsUserError) return refused(error.message);
    console.error(`Could not start a session for ${start.userId}`, error);
    return refused("The session couldn't start. Outrunner logged why.");
  }
}

function refused(errorMessage: string): ServerSessionResult {
  return { workspaceId: null, status: "refused", errorMessage };
}
