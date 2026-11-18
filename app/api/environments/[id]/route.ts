import { NextResponse } from "next/server";

import { after } from "@/lib/observability/after";
import { z } from "zod";

import { recordProjectChange } from "@/lib/audit/project-history";
import { getOwner } from "@/lib/auth/owner";
import { EnvironmentAccessError, getEnvironment, updateEnvironment, type EnvironmentPatch } from "@/lib/db/environments";
import {
  EnvironmentRuleError,
  MAX_DESCRIPTION,
  instructionsText,
  optionalText,
  projectName,
  script,
} from "@/lib/environments/rules";
import { isSameOriginRequest } from "@/lib/http/guards";
import { savingSettings, signInFirst } from "@/lib/http/settings-save";
import { refillAfterChange } from "@/lib/runtime/warm-pool.deps";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A project (an `environments` row; lib/db/environments.ts) for its settings
 * page. GET returns it with its variables' names and its files' paths, never
 * their values. PATCH changes its name, description, instructions, scripts or
 * hooks;
 * a field left out is left as it is, an empty one is cleared.
 */

const Patch = z
  .object({
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    instructions: z.string().nullable().optional(),
    scripts: z
      .object({ setup: z.string().nullable(), run: z.string().nullable(), archive: z.string().nullable() })
      .partial()
      .strict()
      .optional(),
    hooks: z.object({ warm: z.string().nullable(), start: z.string().nullable() }).partial().strict().optional(),
  })
  .strict();

function notFound() {
  return NextResponse.json({ error: "Project not found." }, { status: 404 });
}

export async function GET(_request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  const environment = await getEnvironment(owner.id, id);
  return environment ? NextResponse.json(environment) : notFound();
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return signInFirst();
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That isn't a change a project takes." }, { status: 400 });

  const body = parsed.data;
  let patch: EnvironmentPatch;
  try {
    patch = {
      ...(body.name !== undefined && { name: projectName(body.name) }),
      ...(body.description !== undefined && { description: optionalText(body.description, MAX_DESCRIPTION, "A description") }),
      ...(body.instructions !== undefined && {
        instructions: instructionsText(body.instructions),
      }),
      ...(body.scripts && {
        scripts: {
          ...(body.scripts.setup !== undefined && { setup: script(body.scripts.setup, "setup script") }),
          ...(body.scripts.run !== undefined && { run: script(body.scripts.run, "run script") }),
          ...(body.scripts.archive !== undefined && { archive: script(body.scripts.archive, "archive script") }),
        },
      }),
      ...(body.hooks && {
        hooks: {
          ...(body.hooks.warm !== undefined && { warm: script(body.hooks.warm, "warm hook") }),
          ...(body.hooks.start !== undefined && { start: script(body.hooks.start, "start hook") }),
        },
      }),
    };
  } catch (error) {
    if (error instanceof EnvironmentRuleError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }

  return savingSettings("project settings", async () => {
    if (!(await getEnvironment(owner.id, id))) return notFound();
    try {
      await updateEnvironment(owner.id, id, patch);
    } catch (error) {
      if (error instanceof EnvironmentAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
      throw error;
    }
    // A new warm hook: the project's ready boxes are made again with it.
    if (patch.hooks?.warm !== undefined) after(() => refillAfterChange(owner, id), { where: "refill-pool", userId: owner.id });
    const now = await getEnvironment(owner.id, id);
    // Its hooks and scripts, when they changed, are kept with the change:
    // they're its history (dropped by recordProjectChange when too large).
    if (now) {
      await recordProjectChange(
        owner,
        id,
        "project.changed",
        { fields: Object.keys(patch), ...(patch.hooks && { hooks: now.hooks }), ...(patch.scripts && { scripts: now.scripts }) },
        now,
      );
    }
    return NextResponse.json(now);
  });
}
