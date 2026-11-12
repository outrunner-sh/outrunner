import { after, NextResponse } from "next/server";

import { EnvironmentAccessError } from "@/lib/db/environments";
import { disableEnvironmentSkill } from "@/lib/db/environment-skills";
import { environmentRequest } from "@/lib/http/environment-request";
import { savingSettings } from "@/lib/http/settings-save";
import { refillAfterChange } from "@/lib/runtime/warm-pool.deps";

type RouteContext = { params: Promise<{ id: string; skillId: string }> };

/** Disable one of a project's catalog skills. New sessions start without
 *  it. */
export async function DELETE(request: Request, context: RouteContext) {
  const c = await environmentRequest(request, context.params, { write: true, ids: ["id", "skillId"] });
  if ("response" in c) return c.response;
  const { id, skillId } = c.params;
  return savingSettings("project skills", async () => {
    try {
      if (!(await disableEnvironmentSkill(c.owner.id, id, skillId))) {
        return NextResponse.json({ error: "That skill isn't enabled on this project." }, { status: 404 });
      }
    } catch (error) {
      if (error instanceof EnvironmentAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
    after(() => refillAfterChange(c.owner, id));
    return NextResponse.json({ ok: true });
  });
}
