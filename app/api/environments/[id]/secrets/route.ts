import { NextResponse } from "next/server";
import { z } from "zod";

import { getOwner } from "@/lib/auth/owner";
import {
  EnvironmentAccessError,
  EnvironmentConflictError,
  editEnvironmentSecrets,
  getEnvironment,
} from "@/lib/db/environments";
import { EnvironmentRuleError } from "@/lib/environments/rules";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Set and remove a project's variables and files. Write-only: the answer is
 * the names and paths it keeps after, never a value, and nothing here reads
 * one back. A value is never logged.
 */

const Edit = z
  .object({
    setEnv: z.record(z.string(), z.string()).optional(),
    removeEnv: z.array(z.string()).optional(),
    setFiles: z.record(z.string(), z.string()).optional(),
    removeFiles: z.array(z.string()).optional(),
  })
  .strict();

export async function PATCH(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const parsed = Edit.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That isn't a change a project takes." }, { status: 400 });

  return savingSettings("project variables", async () => {
    if (!(await getEnvironment(owner.id, id))) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
    try {
      return NextResponse.json(await editEnvironmentSecrets(owner.id, id, parsed.data));
    } catch (error) {
      if (error instanceof EnvironmentRuleError) return NextResponse.json({ error: error.message }, { status: 400 });
      if (error instanceof EnvironmentConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
      if (error instanceof EnvironmentAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
  });
}
