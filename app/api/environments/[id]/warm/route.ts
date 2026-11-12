import { NextResponse } from "next/server";

import { after } from "@/lib/observability/after";
import { z } from "zod";

import { getOwner } from "@/lib/auth/owner";
import { bumpGeneration, EnvironmentAccessError, getEnvironment } from "@/lib/db/environments";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";
import { refillAfterChange } from "@/lib/runtime/warm-pool.deps";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * "Try again": make the project's ready boxes again, its warm hook run anew
 * (a failed one isn't retried on its own until the back-off ends). The
 * project as it is after.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  return savingSettings("project warm-up", async () => {
    try {
      if ((await bumpGeneration(owner.id, id)) === null) {
        return NextResponse.json({ error: "Project not found." }, { status: 404 });
      }
    } catch (error) {
      if (error instanceof EnvironmentAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
    after(() => refillAfterChange(owner.id, id), { where: "refill-pool", userId: owner.id });
    return NextResponse.json(await getEnvironment(owner.id, id));
  });
}
