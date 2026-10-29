import { NextResponse } from "next/server";

import { createLearning } from "@/lib/learnings/actions";
import { changingLearnings, learningCaller, learningsView } from "@/lib/learnings/routes";
import { learningScope, parseLearningText } from "@/lib/learnings/rules";

/**
 * Settings → Learnings: the learnings the signed-in user may read in the org
 * the page shows (`?org=`, or `orgId` in a POST's body), the org's and their
 * own (lib/learnings). GET lists them; POST adds one, `{ orgId, scope,
 * title, body }`, a member's for the org filed as a suggestion. Each answers
 * with the page's list.
 */
export async function GET(request: Request) {
  const caller = await learningCaller(request, new URL(request.url).searchParams.get("org"));
  if (caller instanceof Response) return caller;
  return NextResponse.json({ learnings: await learningsView(caller) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const caller = await learningCaller(request, body?.orgId);
  if (caller instanceof Response) return caller;
  const scope = learningScope(body?.scope);
  if (!scope) return NextResponse.json({ error: "Choose the org or yourself." }, { status: 400 });
  const text = parseLearningText(body ?? {});
  if (typeof text === "string") return NextResponse.json({ error: text.replaceAll("`", "") }, { status: 400 });
  return changingLearnings(caller, () =>
    createLearning(caller.actor, caller.deps, { scope, title: text.title as string, body: text.body as string }),
  );
}
