/**
 * Starting a Runner: a cloud session of the Mission's project, made as the
 * Mission's owner (actAsUser, as an automation's are), exactly as the
 * new-session screen makes one, on their sandbox, plan and access. Its brief
 * is its first message, and the Mission is its parent.
 *
 * It runs on the Mission's own model (or the one the Mission asked for), on
 * whatever account the owner runs that on: a Runner is work they asked the
 * Mission for, not something the server starts unasked, so it isn't held to
 * Outrunner's metered models as startServerSession's sessions are.
 */

import { after } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { saveBrief } from "@/lib/missions/store";
import type { RunnerStart } from "@/lib/missions/tools";
import { firstPrompt } from "@/lib/api/create-request";
import { openRunnerWatch, watchSoon } from "@/lib/missions/watch.deps";
import { CLAUDE_MODELS } from "@/lib/runtime/session-models";
import type { Workspace } from "@/lib/runtime/types";
import { createCloudSession, type SessionRequest } from "@/lib/session/create-cloud-session";
import { ActAsUserError, actAsUser } from "@/lib/supabase/acting-user";

/** The new-session request for a Runner of `mission`. */
export function runnerRequest(mission: Pick<Workspace, "model" | "agent">, start: RunnerStart): SessionRequest {
  const own = mission.model;
  let provider: string | undefined = own?.model.provider;
  let model: string | undefined = own?.model.id;
  if (start.model) {
    model = start.model;
    provider =
      start.agent === "codex"
        ? "codex"
        : CLAUDE_MODELS.some((m) => m.id === start.model)
          ? "claude"
          : own && own.model.provider !== "claude" && own.model.provider !== "codex"
            ? own.model.provider
            : "outrunner";
  }
  const agent = start.agent ?? (mission.agent !== "claude" ? mission.agent : undefined);
  return {
    ...(model && { provider, model }),
    ...((start.effort ?? own?.effort) && { effort: start.effort ?? own?.effort }),
    ...(agent && { agent }),
    prompt: start.brief,
  };
}

/**
 * Start the Runner and answer with its id as soon as its row is made; its box
 * is set up after, while the Mission goes on. A refusal (no model, the cap,
 * the plan's box limit) is answered with why.
 */
export async function startRunner(mission: Workspace, start: RunnerStart): Promise<{ runnerId: string } | { error: string }> {
  let made: (id: string) => void = () => undefined;
  const created = new Promise<{ runnerId: string }>((resolve) => {
    made = (runnerId) => resolve({ runnerId });
  });
  const run = (async (): Promise<{ runnerId: string } | { error: string }> => {
    try {
      return await actAsUser(mission.ownerId, async () => {
        const owner = await getOwner();
        if (!owner) return { error: "The Mission's owner can't use Outrunner any more." };
        let runnerId: string | null = null;
        const response = await createCloudSession(owner, mission.projectId, runnerRequest(mission, start), {
          title: start.name ?? start.brief.replace(/\s+/g, " ").slice(0, 80),
          // Plan mode as the API asks it of a session (lib/api/create-request.ts).
          firstMessage: firstPrompt({ prompt: start.brief, planMode: start.planMode }),
          // Set up before this returns: the owner is signed in only as long.
          inline: true,
          parentMissionId: mission.id,
          ...(mission.environmentId && { environmentId: mission.environmentId }),
          onCreated: async (id) => {
            runnerId = id;
            await saveBrief(mission.id, id, start.brief).catch((error: unknown) =>
              console.error(`Runner ${id}: its brief wasn't kept`, error),
            );
            // Its first turn is watched from now: through its setup, so a
            // setup that fails reaches the Mission as needing attention.
            await openRunnerWatch(id, new Date(), null).catch((error: unknown) =>
              console.error(`Runner ${id}: its turn can't be watched`, error),
            );
            made(id);
          },
        });
        if (runnerId) watchSoon(runnerId);
        if (response.status === 202 && runnerId) return { runnerId };
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        return { error: typeof body?.error === "string" ? body.error : `it was refused (${response.status})` };
      });
    } catch (error) {
      if (error instanceof ActAsUserError) return { error: error.message };
      console.error(`Mission ${mission.id}: a Runner didn't start`, error);
      return { error: "Outrunner couldn't start it, and logged why." };
    }
  })();
  // The setup outlives the tool's answer: held open for it.
  try {
    after(() => run.then(() => undefined));
  } catch {
    // Outside a request (a test, a script): the promise runs on its own.
  }
  return Promise.race([created, run]);
}
