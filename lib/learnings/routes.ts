/**
 * What the app's learnings routes (app/api/learnings) share: the signed-in
 * caller as a learnings actor in the org the page shows, and a refusal from
 * the actions answered as the page shows one.
 */

import { NextResponse } from "next/server";

import { getOwner, type Owner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";
import { isUuid } from "@/lib/ids";
import { LearningError, listLearnings, type LearningDeps } from "@/lib/learnings/actions";
import { learningActor, learningDeps } from "@/lib/learnings/actions.deps";
import { type Learning, type LearningActor, learningRights } from "@/lib/learnings/rules";

export type LearningCaller = { owner: Owner; actor: LearningActor; deps: LearningDeps };

/** The caller, in the org `orgId` names, or the answer to give: 403 for
 *  another site, 401 signed out, 404 for an org they aren't in. */
export async function learningCaller(request: Request, orgId: unknown): Promise<LearningCaller | Response> {
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  if (typeof orgId !== "string" || !isUuid(orgId)) return NextResponse.json({ error: "No such org." }, { status: 404 });
  const actor = await learningActor(owner.id, orgId);
  if (!actor) return NextResponse.json({ error: "No such org." }, { status: 404 });
  return { owner, actor, deps: learningDeps(owner) };
}

/** What the page lists: every learning the caller may read in the org, with
 *  whether they may change each. */
export type LearningView = Learning & { canEdit: boolean };

export async function learningsView(caller: Pick<LearningCaller, "actor" | "deps">): Promise<LearningView[]> {
  return (await listLearnings(caller.actor, caller.deps)).map((l) => ({ ...l, canEdit: learningRights(caller.actor, l).write }));
}

/** Run a change, answering the actions' refusal with its reason, and then
 *  with the page's list. */
export function changingLearnings(caller: LearningCaller, change: () => Promise<unknown>): Promise<Response> {
  return savingSettings("learnings", async () => {
    try {
      await change();
    } catch (error) {
      if (error instanceof LearningError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
    return NextResponse.json({ learnings: await learningsView(caller) });
  });
}
