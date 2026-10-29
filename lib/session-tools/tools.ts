/**
 * A session's own commands for reaching Outrunner, run by the agent working
 * in it (`outrunner-session …`, runtime-agent/internal/sessiontools), which
 * reach here through its box's agent, signed (app/api/runtime/session-tools).
 * Each acts as the session's user, in the session's org, with what they may
 * do there: an agent can do no more than its user could.
 *
 *   suggest_learning   a learning for the user or the org, filed as a
 *                      suggestion the user (or an org admin) accepts
 *
 * Pure but for what's given (deps), for the route and the tests.
 */

import { createLearning, LearningError, type LearningDeps } from "@/lib/learnings/actions";
import { type LearningActor, learningScope, parseLearningText } from "@/lib/learnings/rules";

/** The session a call is for: its user, its org, and itself. */
export type SessionToolScope = { userId: string; orgId: string; workspaceId: string };

export type SessionToolDeps = {
  /** The user as a learnings actor in the org; null once they aren't a member. */
  actor(userId: string, orgId: string): Promise<LearningActor | null>;
  learnings: LearningDeps;
  /** The app's address, for the links the answers give. */
  base: string;
};

/** What a call answers: text for the agent, or why not, with a status. */
export type SessionToolAnswer = { status: number; text?: string; error?: string };

function refuse(status: number, error: string): SessionToolAnswer {
  return { status, error };
}

export async function callSessionTool(
  scope: SessionToolScope,
  tool: string,
  args: Record<string, unknown>,
  deps: SessionToolDeps,
): Promise<SessionToolAnswer> {
  const actor = await deps.actor(scope.userId, scope.orgId);
  if (!actor) return refuse(403, "The session's user is no longer a member of its org.");
  switch (tool) {
    case "suggest_learning":
      return suggestLearning(actor, scope, args, deps);
    default:
      return refuse(404, `Outrunner has no ${tool}: update the command (\`outrunner-session --help\`).`);
  }
}

async function suggestLearning(
  actor: LearningActor,
  scope: SessionToolScope,
  args: Record<string, unknown>,
  deps: SessionToolDeps,
): Promise<SessionToolAnswer> {
  let where = learningScope(args.scope ?? "personal");
  if (!where) return refuse(400, "A learning is for the user (personal) or the org.");
  // A personal org's learnings are its person's own.
  if (where === "org" && (await deps.learnings.personalOrg?.(scope.orgId))) where = "personal";
  const text = parseLearningText(args);
  if (typeof text === "string") return refuse(400, text.replaceAll("`", ""));
  try {
    const learning = await createLearning(actor, deps.learnings, {
      scope: where,
      title: text.title as string,
      body: text.body as string,
      suggested: true,
      suggestedIn: scope.workspaceId,
    });
    const url = new URL("/settings/learnings", deps.base).toString();
    const who = learning.scope === "org" ? "the org's admins" : "the user";
    return {
      status: 201,
      text: `Suggested "${learning.title}". It isn't saved: it waits for ${who} to accept or dismiss it in Settings → Learnings (${url}).`,
    };
  } catch (error) {
    if (error instanceof LearningError) return refuse(error.status, error.message);
    throw error;
  }
}
