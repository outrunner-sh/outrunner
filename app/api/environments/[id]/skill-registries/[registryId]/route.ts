import { NextResponse } from "next/server";

import { after } from "@/lib/observability/after";

import { EnvironmentAccessError } from "@/lib/db/environments";
import { removeSkillRegistry } from "@/lib/db/environment-skills";
import { environmentRequest } from "@/lib/http/environment-request";
import { savingSettings } from "@/lib/http/settings-save";
import { refillAfterChange } from "@/lib/runtime/warm-pool.deps";

type RouteContext = { params: Promise<{ id: string; registryId: string }> };

/** Remove one of a project's skill registries. New sessions start without
 *  its skills. */
export async function DELETE(request: Request, context: RouteContext) {
  const c = await environmentRequest(request, context.params, { write: true, ids: ["id", "registryId"] });
  if ("response" in c) return c.response;
  const { id, registryId } = c.params;
  return savingSettings("project skill registries", async () => {
    try {
      if (!(await removeSkillRegistry(c.owner.id, id, registryId))) {
        return NextResponse.json({ error: "That isn't one of this project's registries." }, { status: 404 });
      }
    } catch (error) {
      if (error instanceof EnvironmentAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
    after(() => refillAfterChange(c.owner, id), { where: "refill-pool", userId: c.owner.id });
    return NextResponse.json({ ok: true });
  });
}
