import { NextResponse } from "next/server";

import { deleteLearning, updateLearning } from "@/lib/learnings/actions";
import { changingLearnings, learningCaller } from "@/lib/learnings/routes";
import { parseLearningText } from "@/lib/learnings/rules";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * One learning, from Settings → Learnings, in the org the page shows
 * (`orgId` in the body, `?org=` for DELETE). PATCH changes its `title` and
 * `body`, or accepts a suggestion (`accept: true`); DELETE deletes it, or
 * dismisses a suggestion. Each answers with the page's list.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const caller = await learningCaller(request, body?.orgId);
  if (caller instanceof Response) return caller;
  const text = parseLearningText(body ?? {}, { partial: true });
  if (typeof text === "string") return NextResponse.json({ error: text.replaceAll("`", "") }, { status: 400 });
  return changingLearnings(caller, () =>
    updateLearning(caller.actor, caller.deps, id, { ...text, ...(body?.accept === true && { status: "active" as const }) }),
  );
}

export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const caller = await learningCaller(request, new URL(request.url).searchParams.get("org"));
  if (caller instanceof Response) return caller;
  return changingLearnings(caller, () => deleteLearning(caller.actor, caller.deps, id));
}
