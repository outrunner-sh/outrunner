/**
 * The public API's learnings (docs/api.md): the org's that the key's org
 * keeps, and the key's maker's own. Each goes through the learnings' actions
 * (lib/learnings/actions.ts), as the app's Settings → Learnings does, with the
 * caller's role in the key's org: a member's learning for the org is a
 * suggestion its admins accept, and only they change or delete the org's.
 */

import { apiError } from "@/lib/api/errors";
import { jsonBody, type ApiContext } from "@/lib/api/handler";
import { paginate, pageRequest } from "@/lib/api/pagination";
import { learningJson } from "@/lib/api/serialize";
import {
  createLearning,
  deleteLearning,
  getLearning,
  LearningError,
  listLearnings,
  updateLearning,
  type LearningDeps,
} from "@/lib/learnings/actions";
import { learningDeps } from "@/lib/learnings/actions.deps";
import { type LearningActor, learningScope, learningStatus, parseLearningText } from "@/lib/learnings/rules";

function actorOf(context: ApiContext): LearningActor {
  return { userId: context.caller.userId, orgId: context.caller.orgId, role: context.caller.role };
}

/** Run an operation, answering its refusal in the API's envelope. */
async function answering(work: (actor: LearningActor, deps: LearningDeps) => Promise<Response>, context: ApiContext) {
  try {
    return await work(actorOf(context), learningDeps(context.owner));
  } catch (error) {
    if (error instanceof LearningError) return apiError(error.status, error.message);
    throw error;
  }
}

/** GET /learnings: `scope` (org, personal) and `status` (active, suggested)
 *  narrow it; the org's come first, each oldest first. */
export async function listLearningsApi(context: ApiContext): Promise<Response> {
  const params = new URL(context.request.url).searchParams;
  const page = pageRequest(params);
  if (typeof page === "string") return apiError(400, page);
  const scope = params.get("scope");
  if (scope && !learningScope(scope)) return apiError(400, "`scope` is org or personal.");
  const status = params.get("status");
  if (status && !learningStatus(status)) return apiError(400, "`status` is active or suggested.");
  return answering(async (actor, deps) => {
    const learnings = await listLearnings(actor, deps, {
      scope: learningScope(scope) ?? undefined,
      status: learningStatus(status) ?? undefined,
    });
    return Response.json(paginate(learnings.map((l) => learningJson(l, actor)), page));
  }, context);
}

/** POST /learnings: `{ scope, title, body }`. `suggest: true` files it as a
 *  suggestion even where the caller could add it at once. */
export async function createLearningApi(context: ApiContext): Promise<Response> {
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  const scope = learningScope(body.scope ?? "personal");
  if (!scope) return apiError(400, "`scope` is org or personal.");
  const text = parseLearningText(body);
  if (typeof text === "string") return apiError(400, text);
  if (body.suggest !== undefined && typeof body.suggest !== "boolean") return apiError(400, "`suggest` is true or false.");
  return answering(async (actor, deps) => {
    const learning = await createLearning(actor, deps, {
      scope,
      title: text.title as string,
      body: text.body as string,
      suggested: body.suggest === true,
    });
    return Response.json(learningJson(learning, actor), { status: 201 });
  }, context);
}

/** GET /learnings/{id}. */
export async function getLearningApi(context: ApiContext, id: string): Promise<Response> {
  return answering(async (actor, deps) => Response.json(learningJson(await getLearning(actor, deps, id), actor)), context);
}

/** PATCH /learnings/{id}: a new `title` or `body`, or `status: "active"` to
 *  accept a suggestion. */
export async function updateLearningApi(context: ApiContext, id: string): Promise<Response> {
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  const text = parseLearningText(body, { partial: true });
  if (typeof text === "string") return apiError(400, text);
  const status = body.status === undefined ? undefined : learningStatus(body.status);
  if (status === null) return apiError(400, "`status` is active, to accept a suggestion.");
  if (text.title === undefined && text.body === undefined && status === undefined) {
    return apiError(400, "Send a new `title`, `body` or `status`.");
  }
  return answering(async (actor, deps) => {
    const learning = await updateLearning(actor, deps, id, { ...text, ...(status && { status }) });
    return Response.json(learningJson(learning, actor));
  }, context);
}

/** DELETE /learnings/{id}: delete it, or dismiss a suggestion. */
export async function deleteLearningApi(context: ApiContext, id: string): Promise<Response> {
  return answering(async (actor, deps) => {
    await deleteLearning(actor, deps, id);
    return new Response(null, { status: 204 });
  }, context);
}
